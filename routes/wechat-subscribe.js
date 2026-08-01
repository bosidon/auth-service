/**
 * 微信订阅通知（单次订阅）推送模块
 * - GET  /wechat/subscribe-authorize   生成订阅授权跳转URL（需登录）
 * - GET  /wechat/subscribe-callback    授权回调：记录授权 + 跳回
 * - POST /api/auth/wechat/subscribe/send  发送订阅消息（需登录）
 */
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

const APPID = process.env.WECHAT_APPID;
const SECRET = process.env.WECHAT_SECRET;

// 授权会话（sid → { openid, templateId, returnUrl, expires }）
const grantSessions = new Map();

// ===== 1. 订阅授权跳转 =====
router.get('/wechat/subscribe-authorize', authenticateToken, async (req, res) => {
  try {
    const { template_id, returnUrl, scene } = req.query;
    if (!template_id || !returnUrl) {
      return res.status(400).json({ success: false, error: '缺少参数' });
    }
    // returnUrl 白名单校验（只允许 xianbao.online 子域）
    if (!/^https:\/\/([\w-]+\.)*xianbao\.online\//.test(returnUrl)) {
      return res.status(400).json({ success: false, error: '无效的跳转地址' });
    }
    // 查当前用户的 openid
    const bind = await db.get(
      "SELECT identifier FROM user_bindings WHERE user_id = ? AND provider = 'wechat'",
      [req.user.id]
    );
    if (!bind) {
      return res.status(400).json({ success: false, error: '请先绑定微信' });
    }
    const sid = crypto.randomBytes(8).toString('hex');
    // scene 必须为数字（微信 H5 订阅通知要求）
    const sceneMap = { tarot: 1001, test: 1002, maya: 1003, energy: 1004 };
    const sceneNum = sceneMap[scene] || 1001;
    grantSessions.set(sid, {
      openid: bind.identifier,
      templateId: template_id,
      returnUrl,
      scene: scene || 'default',
      expires: Date.now() + 5 * 60 * 1000
    });
    const redirect = 'https://mp.weixin.qq.com/mp/subscribemsg?action=get_confirm'
      + '&appid=' + encodeURIComponent(APPID)
      + '&scene=' + sceneNum
      + '&template_id=' + encodeURIComponent(template_id)
      + '&redirect_url=' + encodeURIComponent('https://auth.xianbao.online/wechat/subscribe-callback?sid=' + sid)
      + '#wechat_redirect';
    console.log('[subscribe-authorize] openid=' + bind.identifier.slice(0, 8) + ' scene=' + sceneNum + ' tpl=' + template_id.slice(0, 8));
    console.log('[subscribe-authorize] redirect=' + redirect.slice(0, 160));
    res.redirect(redirect);
  } catch (e) {
    console.error('订阅授权跳转失败:', e);
    res.status(500).json({ success: false, error: '服务器错误' });
  }
});

// ===== 2. 授权回调：记录授权次数 =====
router.get('/wechat/subscribe-callback', async (req, res) => {
  try {
    const { sid } = req.query;
    const session = grantSessions.get(sid);
    if (session && Date.now() < session.expires) {
      grantSessions.delete(sid);
      // 记录授权（单次订阅 = 可发1条）
      await db.run(
        `INSERT INTO wechat_subscribe_grants (openid, template_id, scene, granted_at, used) VALUES (?, ?, ?, datetime('now'), 0)`,
        [session.openid, session.templateId, session.scene]
      );
    }
    res.redirect(session ? session.returnUrl : 'https://xianbao.online/');
  } catch (e) {
    console.error('订阅授权回调失败:', e);
    res.redirect('https://xianbao.online/');
  }
});

// ===== 3. 发送订阅消息 =====
router.post('/api/auth/wechat/subscribe/send', authenticateToken, async (req, res) => {
  try {
    const { template_id, data, returnUrl } = req.body;
    if (!template_id || !data) {
      return res.status(400).json({ success: false, error: '缺少参数' });
    }
    // 查 openid
    const bind = await db.get(
      "SELECT identifier FROM user_bindings WHERE user_id = ? AND provider = 'wechat'",
      [req.user.id]
    );
    if (!bind) {
      return res.json({ success: false, error: '请先绑定微信' });
    }
    const openid = bind.identifier;

    // 检查授权配额
    const grant = await db.get(
      `SELECT id FROM wechat_subscribe_grants WHERE openid = ? AND template_id = ? AND used = 0 ORDER BY id DESC LIMIT 1`,
      [openid, template_id]
    );
    if (!grant) {
      return res.json({ success: false, error: '请先授权接收通知' });
    }

    // 调用微信订阅消息发送接口
    const token = await getAccessToken();
    const payload = { touser: openid, template_id, data: {} };
    for (const key in data) {
      payload.data[key] = { value: String(data[key]) };
    }
    const r = await fetch(`https://api.weixin.qq.com/cgi-bin/message/subscribe/bizsend?access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const j = await r.json();

    if (j.errcode === 0) {
      // 扣减授权
      await db.run(`UPDATE wechat_subscribe_grants SET used = 1, used_at = datetime('now') WHERE id = ?`, [grant.id]);
      return res.json({ success: true });
    }
    if (j.errcode === 43101) {
      // 用户拒收/未授权
      await db.run(`UPDATE wechat_subscribe_grants SET used = 1, used_at = datetime('now') WHERE id = ?`, [grant.id]);
      return res.json({ success: false, error: '用户未授权接收' });
    }
    res.json({ success: false, error: '发送失败: ' + (j.errmsg || '未知错误') });
  } catch (e) {
    console.error('订阅消息发送失败:', e);
    res.status(500).json({ success: false, error: '服务器错误' });
  }
});

// access_token 缓存
let cachedToken = null;
let cachedTokenExpires = 0;
async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpires) return cachedToken;
  const r = await fetch(`https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${APPID}&secret=${SECRET}`);
  const j = await r.json();
  if (!j.access_token) throw new Error('access_token 获取失败: ' + (j.errmsg || ''));
  cachedToken = j.access_token;
  cachedTokenExpires = Date.now() + (j.expires_in - 300) * 1000;
  return cachedToken;
}

// ===== 4. JS-SDK 签名（wx.config 用） =====
let cachedTicket = null;
let cachedTicketExpires = 0;

async function getJsapiTicket() {
  if (cachedTicket && Date.now() < cachedTicketExpires) return cachedTicket;
  const token = await getAccessToken();
  const r = await fetch(`https://api.weixin.qq.com/cgi-bin/ticket/getticket?access_token=${token}&type=jsapi`);
  const j = await r.json();
  if (j.errcode !== 0) throw new Error('jsapi_ticket获取失败: ' + (j.errmsg || ''));
  cachedTicket = j.ticket;
  cachedTicketExpires = Date.now() + (j.expires_in - 300) * 1000;
  return cachedTicket;
}

router.get('/api/auth/wechat/jssdk-config', async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).json({ success: false, error: '缺少url参数' });
    const ticket = await getJsapiTicket();
    const timestamp = Math.floor(Date.now() / 1000);
    const nonceStr = Math.random().toString(36).substr(2, 15);
    const str = `jsapi_ticket=${ticket}&noncestr=${nonceStr}&timestamp=${timestamp}&url=${url}`;
    const signature = crypto.createHash('sha1').update(str).digest('hex');
    res.json({ success: true, data: { appId: APPID, timestamp, nonceStr, signature } });
  } catch (e) {
    console.error('JS-SDK签名失败:', e);
    res.status(500).json({ success: false, error: '签名失败' });
  }
});

module.exports = router;
