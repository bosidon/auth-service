const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const db = require('../config/database');
const { generateToken, setTokenCookie } = require('../middleware/auth');

// ===== 创蓝云智短信发送 =====
async function sendSms(phone, code) {
  const account = process.env.CL_ACCOUNT;
  const password = process.env.CL_PASSWORD;
  const msg = '【致虚极心理】你在「仙宝心灵成长」网站的验证码是' + code + '，5 分钟内有效。';
  const resp = await fetch('https://smssh1.253.com/msg/v1/send/json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: account, password: password, msg: msg, phone: phone, report: true })
  });
  const data = await resp.json();
  if (data.code !== '0') {
    throw new Error('短信发送失败: ' + (data.errorMsg || data.code));
  }
  return data;
}

// ===== 发送手机验证码 =====
router.post('/send-phone-code', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone || !/^1[3-9]\d{9}$/.test(phone)) {
      return res.status(400).json({ success: false, error: '请输入有效的手机号' });
    }

    // 60秒冷却
    const recent = await db.get(
      `SELECT created_at FROM sms_codes WHERE phone = ? AND used = 0 AND created_at > datetime('now', '-1 minute') ORDER BY created_at DESC LIMIT 1`,
      [phone]
    );
    if (recent) {
      return res.status(429).json({ success: false, error: '验证码已发送，请60秒后重试' });
    }

    // 每天每手机号上限10次
    const todayCount = await db.get(
      `SELECT COUNT(*) as c FROM sms_codes WHERE phone = ? AND created_at > datetime('now', '-1 day')`,
      [phone]
    );
    if (todayCount && todayCount.c >= 10) {
      return res.status(429).json({ success: false, error: '今日验证码发送次数已达上限' });
    }

    const code = String(Math.floor(10000 + Math.random() * 90000));
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    await db.run(
      'INSERT INTO sms_codes (phone, code, expires_at) VALUES (?, ?, ?)',
      [phone, code, expiresAt]
    );

    await sendSms(phone, code);

    res.json({ success: true, message: '验证码已发送' });
  } catch (error) {
    console.error('发送手机验证码失败:', error);
    res.status(500).json({ success: false, error: '短信发送失败，请稍后重试' });
  }
});

// ===== 手机验证码登录/注册 =====
router.post('/login-with-phone', async (req, res) => {
  try {
    const { phone, code } = req.body;
    if (!phone || !code) {
      return res.status(400).json({ success: false, error: '请填写手机号和验证码' });
    }
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      return res.status(400).json({ success: false, error: '手机号格式不正确' });
    }

    const validCode = await db.get(
      `SELECT id, code, expires_at, used FROM sms_codes WHERE phone = ? ORDER BY created_at DESC LIMIT 1`,
      [phone]
    );

    if (!validCode) return res.status(400).json({ success: false, error: '请先获取验证码' });
    if (validCode.used) return res.status(400).json({ success: false, error: '验证码已使用' });
    if (new Date(validCode.expires_at) < new Date()) return res.status(400).json({ success: false, error: '验证码已过期，请重新获取' });
    if (validCode.code !== code) return res.status(400).json({ success: false, error: '验证码错误' });

    await db.run('UPDATE sms_codes SET used = 1 WHERE id = ?', [validCode.id]);

    let user = await db.get('SELECT id, email, nickname, role, plan, phone FROM users WHERE phone = ?', [phone]);

    if (!user) {
      // 自动注册
      const nick = '用户' + phone.slice(-4);
      const virtualEmail = 'phone_' + phone + '@sms.local';
      const randomHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
      const result = await db.run(
        `INSERT INTO users (email, phone, password_hash, nickname, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
        [virtualEmail, phone, randomHash, nick]
      );
      user = { id: result.lastID, email: virtualEmail, nickname: nick, role: 'user', plan: 'free', phone: phone };
    }

    const token = generateToken(user);
    setTokenCookie(res, token);

    await db.run(
      `INSERT INTO user_logs (user_id, action, detail, ip, user_agent) VALUES (?, ?, ?, ?, ?)`,
      [user.id, 'login', JSON.stringify({ method: 'phone_code' }), req.ip, req.headers['user-agent'] || '']
    );

    res.json({
      success: true,
      data: {
        user: { id: user.id, email: user.email, nickname: user.nickname, role: user.role, phone: user.phone },
        token
      }
    });
  } catch (error) {
    console.error('手机验证码登录失败:', error);
    res.status(500).json({ success: false, error: '服务器错误' });
  }
});

module.exports = router;
