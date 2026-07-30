/**
 * 微信扫码登录（开放平台「网站应用」qrconnect，方案 A）
 * 挂载于 /api/auth/wechat/* —— 与 routes/auth.js 同级
 * 复用：
 *   - config/database  （单连接，避免与 xianbao-auth 既有连接互相阻塞）
 *   - middleware/auth   （generateToken / setTokenCookie / authenticateToken / optionalAuth / JWT_SECRET）
 * 约定：WECHAT_APPSECRET 仅本服务加载；微信身份只落 user_oauth，主键为 users.id
 */
const express = require('express');
const crypto = require('crypto');
const fetch = globalThis.fetch || require('node-fetch');
const db = require('../config/database');
const {
  authenticateToken,
  optionalAuth,
  generateToken,
  setTokenCookie,
  JWT_SECRET,
} = require('../middleware/auth');

const router = express.Router();

const APPID = process.env.WECHAT_APPID;
const SECRET = process.env.WECHAT_APPSECRET;
const CALLBACK = process.env.WECHAT_CALLBACK_URL || 'https://auth.xianbao.online/api/auth/wechat/callback';
const SUCCESS_REDIRECT = process.env.WECHAT_SUCCESS_REDIRECT || 'https://www.xianbao.online/';

// ---- 审计（对齐 user_logs 默认列，created_at 走默认值）----
async function audit(userId, action, detail) {
  try {
    await db.run(
      'INSERT INTO user_logs(user_id, action, detail) VALUES(?,?,?)',
      [userId || 0, action, JSON.stringify(detail || {})]
    );
  } catch (_) { /* 审计失败不阻断主流程 */ }
}

// ---- state 防 CSRF：HMAC(随机值, JWT_SECRET) ----
function signState(random) {
  const mac = crypto.createHmac('sha256', JWT_SECRET).update(random).digest('hex').slice(0, 16);
  return `${random}.${mac}`;
}
function verifyState(signed) {
  if (typeof signed !== 'string' || !signed.includes('.')) return false;
  const [r, mac] = signed.split('.');
  const exp = crypto.createHmac('sha256', JWT_SECRET).update(r).digest('hex').slice(0, 16);
  return mac === exp;
}

// 命中策略：unionid > (provider+openid)；未命中则「已登录→绑定当前账号 / 未登录→新建 free 账号」
async function upsertWechatUser({ openid, unionid, nickname, avatar_url, reqUser }) {
  let row = unionid ? await db.get('SELECT * FROM user_oauth WHERE unionid=?', [unionid]) : null;
  if (!row) row = await db.get("SELECT * FROM user_oauth WHERE provider='wechat_web' AND openid=?", [openid]);
  if (row) return row.user_id;

  if (reqUser && reqUser.id) {
    await db.run(
      "INSERT INTO user_oauth(user_id,provider,openid,unionid,nickname,avatar_url) VALUES(?,?,?,?,?,?)",
      [reqUser.id, 'wechat_web', openid, unionid || null, nickname, avatar_url]
    );
    return reqUser.id;
  }

  try {
    const nick = nickname || ('微信用户' + openid.slice(-4));
    const email = 'wx_' + openid + '@xianbao.local';
    const res1 = await db.run(
      "INSERT INTO users(username,email,password_hash,nickname,plan,created_at,updated_at) VALUES(?,?,?,'',?,datetime('now'),datetime('now'))",
      [nick, email, nick, 'free']
    );
    const userId = res1.lastID;
    await db.run(
      "INSERT INTO user_oauth(user_id,provider,openid,unionid,nickname,avatar_url) VALUES(?,?,?,?,?,?)",
      [userId, 'wechat_web', openid, unionid || null, nickname, avatar_url]
    );
    return userId;
  } catch (e) {
    if (e && /UNIQUE/.test(e.message)) {
      const r = unionid
        ? await db.get('SELECT * FROM user_oauth WHERE unionid=?', [unionid])
        : await db.get("SELECT * FROM user_oauth WHERE provider='wechat_web' AND openid=?", [openid]);
      if (r) return r.user_id; // 并发竞态：另一条请求已建好
    }
    throw e;
  }
}

// ---- 授权入口（登录页 / 绑定入口调用）----
router.get('/authorize', (req, res) => {
  const random = crypto.randomBytes(16).toString('hex');
  const state = signState(random);
  const url =
    'https://open.weixin.qq.com/connect/qrconnect' +
    `?appid=${APPID}` +
    `&redirect_uri=${encodeURIComponent(CALLBACK)}` +
    '&response_type=code&scope=snsapi_login' +
    `&state=${encodeURIComponent(state)}#wechat_redirect`;
  res.cookie('wx_state', state, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 5 * 60 * 1000 });
  res.redirect(url);
});

// ---- 回调：换码 -> 身份解析 -> 登录/绑定 -> 签 JWT -> SSO ----
router.get('/callback', optionalAuth, async (req, res) => {
  const { code, state } = req.query;
  const cookieState = req.cookies && req.cookies.wx_state;

  // Unwanted：state 缺失/篡改/不匹配 -> 拒绝 + 审计 + 回跳带 error
  if (!state || !verifyState(state) || state !== cookieState) {
    await audit(null, 'wechat_login_fail', { reason: 'state' });
    return res.redirect(SUCCESS_REDIRECT + '?error=wechat_state');
  }
  try {
    const tokenRes = await fetch(
      `https://api.weixin.qq.com/sns/oauth2/access_token?appid=${APPID}&secret=${SECRET}&code=${code}&grant_type=authorization_code`
    ).then((r) => r.json());
    if (tokenRes.errcode) throw new Error(`wechat:${tokenRes.errcode}:${tokenRes.errmsg}`);

    const { openid, unionid, access_token } = tokenRes;
    let nickname = null, avatar_url = null;
    try {
      const ui = await fetch(
        `https://api.weixin.qq.com/sns/userinfo?access_token=${access_token}&openid=${openid}&lang=zh_CN`
      ).then((r) => r.json());
      if (!ui.errcode) { nickname = ui.nickname; avatar_url = ui.headimgurl; }
    } catch (_) { /* userinfo 可选，失败不影响登录 */ }

    const userId = await upsertWechatUser({ openid, unionid, nickname, avatar_url, reqUser: req.user });

    // 取完整用户记录，复用 generateToken 保证 JWT 载荷与其他登录方式一致
    const user = await db.get(
      'SELECT id, username, email, nickname, role, plan FROM users WHERE id=?',
      [userId]
    );
    const token = generateToken(user);
    setTokenCookie(res, token); // cookie 名 xianbao_token，domain .xianbao.online，与其他登录共用 SSO

    await audit(userId, 'wechat_login_success', {});
    res.redirect(SUCCESS_REDIRECT);
  } catch (e) {
    // Unwanted：微信接口异常 -> 不绕过 + 审计 + 回跳带 error
    await audit(null, 'wechat_login_fail', { reason: 'token_err', msg: e.message });
    res.redirect(SUCCESS_REDIRECT + '?error=wechat');
  }
});

// ---- 绑定（已登录态，由前端携带微信身份调起 authorize 后回写）----
router.post('/bind', authenticateToken, async (req, res) => {
  const { openid, unionid, nickname, avatar_url } = req.body || {};
  if (!openid) return res.status(400).json({ success: false, error: 'openid required' });
  try {
    await upsertWechatUser({ openid, unionid, nickname, avatar_url, reqUser: req.user });
    await audit(req.user.id, 'wechat_bind', {});
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ---- 解绑（唯一登录方式需二次确认，由前端保证）----
router.post('/unbind', authenticateToken, async (req, res) => {
  try {
    const count = await db.get('SELECT COUNT(*) AS c FROM user_oauth WHERE user_id=?', [req.user.id]);
    const u = await db.get('SELECT password_hash FROM users WHERE id=?', [req.user.id]);
    if (count && count.c <= 1 && u && !u.password_hash) {
      return res.status(409).json({
        success: false, error: 'last_login_method',
        message: '微信是当前唯一登录方式，请先设置密码',
      });
    }
    await db.run("DELETE FROM user_oauth WHERE user_id=? AND provider='wechat_web'", [req.user.id]);
    await audit(req.user.id, 'wechat_unbind', {});
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ---- 绑定状态 ----
router.get('/status', authenticateToken, async (req, res) => {
  try {
    const row = await db.get(
      "SELECT nickname, avatar_url FROM user_oauth WHERE user_id=? AND provider='wechat_web'",
      [req.user.id]
    );
    res.json({ success: true, data: { bound: !!row, nickname: row && row.nickname, avatarUrl: row && row.avatar_url } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
