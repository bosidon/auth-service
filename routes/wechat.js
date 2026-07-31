/**
 * 微信服务号 扫码关注登录
 * - GET  /wechat/callback         微信服务器验证（echostr）
 * - POST /wechat/callback         接收关注/扫码事件
 * - POST /api/auth/wechat/qrcode  生成带参临时二维码
 * - GET  /api/auth/wechat/status  前端轮询登录状态
 */
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../config/database');
const { generateToken, setTokenCookie } = require('../middleware/auth');

const APPID = process.env.WECHAT_APPID;
const SECRET = process.env.WECHAT_SECRET;
const TOKEN = process.env.WECHAT_TOKEN || 'xianbao2026';

// 登录会话：sid -> { userId, expires }
const sessions = new Map();
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

/* 根据 openid 查绑定，无则创建微信用户 */
async function findOrCreateUser(openid) {
  const bind = await db.get(
    "SELECT user_id FROM user_bindings WHERE provider = 'wechat' AND identifier = ?",
    [openid]
  );
  if (bind) {
    return db.get('SELECT id, username, email, nickname, role, plan FROM users WHERE id = ?', [bind.user_id]);
  }
  const username = 'wx_' + openid;
  const email = username + '@wechat.local';
  const hash = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);
  const r = await db.run(
    'INSERT INTO users (username, email, password_hash, nickname, created_at, updated_at) VALUES (?, ?, ?, ?, datetime("now"), datetime("now"))',
    [username, email, hash, '微信用户']
  );
  await db.run(
    "INSERT INTO user_bindings (user_id, provider, identifier) VALUES (?, 'wechat', ?)",
    [r.lastID, openid]
  );
  return db.get('SELECT id, username, email, nickname, role, plan FROM users WHERE id = ?', [r.lastID]);
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
          const user = await findOrCreateUser(msg.FromUserName);
          session.userId = user.id;
          session.openid = msg.FromUserName;
        }
      }
      res.send('success');
    } catch (e) {
      console.error('微信事件处理失败:', e);
      res.send('success');
    }
  });
});

/* ===== 3. 生成带参二维码 ===== */
router.post('/api/auth/wechat/qrcode', async (req, res) => {
  try {
    if (!APPID || !SECRET) {
      return res.status(500).json({ success: false, error: '微信配置缺失' });
    }
    const sid = crypto.randomBytes(8).toString('hex');
    sessions.set(sid, { userId: null, expires: Date.now() + 120000 });
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

/* ===== 4. 轮询登录状态 ===== */
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
    const user = await db.get('SELECT id, username, email, nickname, role, plan FROM users WHERE id = ?', [session.userId]);
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

module.exports = router;

