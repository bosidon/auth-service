/**
 * 微信服务号 扫码关注登录 + 微信内OAuth授权登录
 * - GET  /wechat/callback          微信服务器验证（echostr）
 * - POST /wechat/callback          接收关注/扫码事件
 * - POST /api/auth/wechat/qrcode   生成带参临时二维码（桌面扫码关注）
 * - GET  /api/auth/wechat/status   前端轮询登录状态
 * - GET  /wechat/oauth-authorize   微信内 OAuth 授权跳转（snsapi_userinfo）
 * - GET  /wechat/oauth-callback    OAuth 回调：code换token→建账号→跳回原页面
 */
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../config/database');
const { generateToken, setTokenCookie, optionalAuth } = require('../middleware/auth');

const APPID = process.env.WECHAT_APPID;
const SECRET = process.env.WECHAT_SECRET;
const TOKEN = process.env.WECHAT_TOKEN || 'xianbao2026';
const BASE_URL = 'https://auth.xianbao.online';
// 允许跳回的白名单域名（防开放重定向）
const ALLOWED_RETURN_HOSTS = [
  'xianbao.online', 'www.xianbao.online',
  'auth.xianbao.online', 'read.xianbao.online',
  'maya.xianbao.online', 'ceping.xianbao.online',
  'tarot.xianbao.online'
];

// 扫码登录会话：sid -> { userId, openid, expires }
const sessions = new Map();
// OAuth state：state -> { returnUrl, expires }
const oauthStates = new Map();
// access_token 缓存
let cachedToken = { value: null, expires: 0 };

/* ===== 微信 API 辅助 ===== */

function getAccessToken() {
  if (cachedToken.value && cachedToken.expires > Date.now()) {
    return Promise.resolve(cachedToken.value);
  }
  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${APPID}&secret=${SECRET}`;
  return fetch(url).then(function(r) { return r.json(); }).then(function(j) {
    if (!j.access_token) {
      throw new Error('获取 access_token 失败: ' + (j.errmsg || j.errcode));
    }
    cachedToken.value = j.access_token;
    cachedToken.expires = Date.now() + (j.expires_in - 300) * 1000;
    return j.access_token;
  });
}

function createQrcode(sceneStr) {
  return getAccessToken().then(function(token) {
    return fetch('https://api.weixin.qq.com/cgi-bin/qrcode/create?access_token=' + token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expire_seconds: 120,
        action_name: 'QR_STR_SCENE',
        action_info: { scene: { scene_str: sceneStr } }
      })
    });
  }).then(function(r) { return r.json(); });
}

/** 用 OAuth code 换 access_token（微信内授权） */
function getOauthToken(code) {
  const url = `https://api.weixin.qq.com/sns/oauth2/access_token?appid=${APPID}&secret=${SECRET}&code=${code}&grant_type=authorization_code`;
  return fetch(url).then(function(r) { return r.json(); });
}

/** 获取微信用户信息（OAuth 授权后，含昵称头像） */
function getWechatUserInfo(accessToken, openid) {
  const url = `https://api.weixin.qq.com/sns/userinfo?access_token=${accessToken}&openid=${openid}&lang=zh_CN`;
  return fetch(url).then(function(r) { return r.json(); });
}

/** 获取已关注用户信息（桌面扫码后，cgi-bin 接口） */
function getFollowedUserInfo(openid) {
  return getAccessToken().then(function(token) {
    return fetch(`https://api.weixin.qq.com/cgi-bin/user/info?access_token=${token}&openid=${openid}&lang=zh_CN`);
  }).then(function(r) { return r.json(); });
}

/** 校验 returnUrl 只允许白名单域名 */
function isValidReturnUrl(url) {
  try {
    const u = new URL(url);
    return ALLOWED_RETURN_HOSTS.includes(u.hostname);
  } catch (e) {
    return false;
  }
}

/* 解析微信 XML（CDATA + 纯文本） */
function parseWechatXml(xml) {
  const result = {};
  const cdataRe = /<(\w+)><!\[CDATA\[([\s\S]*?)\]\]><\/\1>/g;
  const textRe = /<(\w+)>([^<]*)<\/\1>/g;
  let m;
  while ((m = cdataRe.exec(xml))) result[m[1]] = m[2];
  while ((m = textRe.exec(xml))) if (!(m[1] in result)) result[m[1]] = m[2];
  return result;
}

/* 根据 openid 查绑定；无则创建微信用户。有昵称头像则覆盖 users 表 */
async function findOrCreateUser(openid, nickname, avatar) {
  const bind = await db.get(
    "SELECT user_id FROM user_bindings WHERE provider = 'wechat' AND identifier = ?",
    [openid]
  );
  if (bind) {
    // 已绑定：有昵称/头像则覆盖（微信身份为准）
    if (nickname || avatar) {
      await db.run(
        'UPDATE users SET nickname = COALESCE(?, nickname), avatar_url = COALESCE(?, avatar_url), updated_at = datetime("now") WHERE id = ?',
        [nickname || null, avatar || null, bind.user_id]
      );
    }
    return db.get('SELECT id, username, email, nickname, avatar_url, role, plan FROM users WHERE id = ?', [bind.user_id]);
  }
  const username = 'wx_' + openid;
  const email = username + '@wechat.local';
  const hash = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);
  const displayName = nickname || '微信用户';
  const r = await db.run(
    'INSERT INTO users (username, email, password_hash, nickname, avatar_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime("now"), datetime("now"))',
    [username, email, hash, displayName, avatar || null]
  );
  await db.run(
    "INSERT INTO user_bindings (user_id, provider, identifier) VALUES (?, 'wechat', ?)",
    [r.lastID, openid]
  );
  return db.get('SELECT id, username, email, nickname, avatar_url, role, plan FROM users WHERE id = ?', [r.lastID]);
}

/* ===== 1. 微信服务器验证 ===== */
router.get('/wechat/callback', (req, res) => {
  const { signature, timestamp, nonce, echostr } = req.query;
  const arr = [TOKEN, timestamp, nonce].sort().join('');
  const sha1 = crypto.createHash('sha1').update(arr).digest('hex');
  if (sha1 === signature) {
    res.send(echostr);
  } else {
    res.send('invalid signature');
  }
});

/* ===== 2. 接收事件推送 ===== */
router.post('/wechat/callback', (req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', async () => {
    try {
      const msg = parseWechatXml(raw);
      if (msg.MsgType === 'event' && (msg.Event === 'subscribe' || msg.Event === 'SCAN')) {
        // EventKey: 未关注扫码=qrscene_<sid>；已关注扫码=<sid>
        let sid = msg.EventKey || '';
        if (sid.startsWith('qrscene_')) sid = sid.substring(8);
        const session = sessions.get(sid);
        if (session && Date.now() < session.expires) {
          if (session.bindMode && session.userId) {
            // 绑定模式：检查该微信是否已绑定账号
            const exist = await db.get(
              "SELECT user_id FROM user_bindings WHERE provider = 'wechat' AND identifier = ?",
              [msg.FromUserName]
            );
            if (!exist) {
              await db.run(
                "INSERT INTO user_bindings (user_id, provider, identifier) VALUES (?, 'wechat', ?)",
                [session.userId, msg.FromUserName]
              );
              session.bindResult = 'bound';
            } else if (exist.user_id === session.userId) {
              session.bindResult = 'already';   // 已绑定当前账号
            } else {
              session.bindResult = 'conflict';  // 已绑定其他账号，拒绝
            }
            session.openid = msg.FromUserName;
          } else {
            // 登录模式：尝试获取昵称头像（仅关注用户可拿到，失败不影响登录）
            let nickname = '', avatar = '';
            try {
              const ui = await getFollowedUserInfo(msg.FromUserName);
              if (ui && ui.nickname) nickname = ui.nickname;
              if (ui && ui.headimgurl) avatar = ui.headimgurl.replace(/\/0$/, '/132');
            } catch (e) {}
            const user = await findOrCreateUser(msg.FromUserName, nickname, avatar);
            session.userId = user.id;
            session.openid = msg.FromUserName;
          }
        }
      }
      res.send('success');
    } catch (e) {
      console.error('微信事件处理失败:', e);
      res.send('success');
    }
  });
});

/* ===== 3. 生成带参二维码（桌面扫码关注登录） ===== */
router.post('/api/auth/wechat/qrcode', optionalAuth, async (req, res) => {
  try {
    if (!APPID || !SECRET) {
      return res.status(500).json({ success: false, error: '微信配置缺失' });
    }
    const sid = crypto.randomBytes(8).toString('hex');
    // bind=1 表示绑定模式：需登录用户，事件回调时绑定到当前账号而非新建
    const bindUserId = req.query.bind === '1' ? (req.user ? req.user.id : null) : null;
    if (req.query.bind === '1' && !bindUserId) {
      return res.status(401).json({ success: false, error: '请先登录' });
    }
    sessions.set(sid, { userId: bindUserId, bindMode: !!bindUserId, expires: Date.now() + 120000 });
    const j = await createQrcode(sid);
    if (!j.ticket) {
      sessions.delete(sid);
      return res.status(500).json({ success: false, error: j.errmsg || '创建二维码失败' });
    }
    res.json({
      success: true,
      data: {
        sid,
        ticket: j.ticket,
        img: 'https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=' + encodeURIComponent(j.ticket)
      }
    });
  } catch (e) {
    console.error('生成二维码失败:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/* ===== 4. 轮询登录状态（桌面扫码） ===== */
router.get('/api/auth/wechat/status', async (req, res) => {
  try {
    const sid = req.query.sid;
    const session = sessions.get(sid);
    if (!session || Date.now() >= session.expires) {
      return res.json({ success: false, error: '二维码已过期，请刷新' });
    }
    if (!session.userId) {
      return res.json({ success: false, pending: true });
    }
    if (session.bindMode) {
      // 绑定模式：不登录，只返回绑定结果
      sessions.delete(sid);
      if (session.bindResult === 'conflict') {
        return res.json({ success: false, error: '该微信已绑定其他账号' });
      }
      if (session.bindResult === 'already') {
        return res.json({ success: true, data: { bound: true, already: true } });
      }
      return res.json({ success: true, data: { bound: true } });
    }
    const user = await db.get('SELECT id, username, email, nickname, avatar_url, role, plan FROM users WHERE id = ?', [session.userId]);
    if (!user) {
      return res.json({ success: false, error: '用户不存在' });
    }
    const token = generateToken(user);
    setTokenCookie(res, token);
    sessions.delete(sid);
    res.json({ success: true, data: { user, token } });
  } catch (e) {
    console.error('查询登录状态失败:', e);
    res.status(500).json({ success: false, error: '服务器错误' });
  }
});

/* ===== 5. 微信内 OAuth 授权跳转 ===== */
router.get('/wechat/oauth-authorize', (req, res) => {
  const returnUrl = req.query.returnUrl || 'https://xianbao.online/';
  if (!isValidReturnUrl(returnUrl)) {
    return res.status(400).send('无效的跳转地址');
  }
  const state = crypto.randomBytes(8).toString('hex');
  oauthStates.set(state, { returnUrl, expires: Date.now() + 600000 });
  const redirect = 'https://open.weixin.qq.com/connect/oauth2/authorize' +
    '?appid=' + APPID +
    '&redirect_uri=' + encodeURIComponent(BASE_URL + '/wechat/oauth-callback') +
    '&response_type=code' +
    '&scope=snsapi_userinfo' +
    '&state=' + state +
    '#wechat_redirect';
  res.redirect(redirect);
});

/* ===== 6. 微信内 OAuth 回调 ===== */
router.get('/wechat/oauth-callback', async (req, res) => {
  const { code, state } = req.query;
  const st = oauthStates.get(state);
  if (!st || Date.now() > st.expires) {
    return res.redirect('https://xianbao.online/?login=expired');
  }
  oauthStates.delete(state);
  if (!code) {
    return res.redirect(st.returnUrl + (st.returnUrl.includes('?') ? '&' : '?') + 'login=fail');
  }
  try {
    // code 换 access_token + openid
    const j = await getOauthToken(code);
    if (!j.openid) {
      console.error('OAuth code 换 token 失败:', j.errmsg || j.errcode);
      return res.redirect(st.returnUrl + (st.returnUrl.includes('?') ? '&' : '?') + 'login=fail');
    }
    // 获取用户信息（昵称头像）
    let nickname = '', avatar = '';
    try {
      const ui = await getWechatUserInfo(j.access_token, j.openid);
      if (ui && ui.nickname) nickname = ui.nickname;
      if (ui && ui.headimgurl) avatar = ui.headimgurl.replace(/\/0$/, '/132');
    } catch (e) {}
    // 查绑定/创建 + 覆盖昵称头像
    const user = await findOrCreateUser(j.openid, nickname, avatar);
    const token = generateToken(user);
    setTokenCookie(res, token);
    // 跳回原页面
    res.redirect(st.returnUrl);
  } catch (e) {
    console.error('微信 OAuth 登录失败:', e);
    res.redirect(st.returnUrl + (st.returnUrl.includes('?') ? '&' : '?') + 'login=fail');
  }
});

module.exports = router;
