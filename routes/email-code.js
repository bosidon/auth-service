const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const db = require('../config/database');
const { generateToken, setTokenCookie } = require('../middleware/auth');

// ===== 发送验证码 =====
router.post('/send-code', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, error: '请输入有效的邮箱地址' });
    }

    // 60秒冷却
    const recent = await db.get(
      `SELECT created_at FROM email_codes WHERE email = ? AND used = 0 AND created_at > datetime('now', '-1 minute') ORDER BY created_at DESC LIMIT 1`,
      [email]
    );
    if (recent) {
      return res.status(429).json({ success: false, error: '验证码已发送，请60秒后重试' });
    }

    // 每天每邮箱上限10次
    const todayCount = await db.get(
      `SELECT COUNT(*) as c FROM email_codes WHERE email = ? AND created_at > datetime('now', '-1 day')`,
      [email]
    );
    if (todayCount && todayCount.c >= 10) {
      return res.status(429).json({ success: false, error: '今日验证码发送次数已达上限' });
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    await db.run(
      'INSERT INTO email_codes (email, code, expires_at) VALUES (?, ?, ?)',
      [email, code, expiresAt]
    );

    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '465'),
      secure: true,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });

    await transporter.sendMail({
      from: process.env.SMTP_FROM || '仙宝心灵成长 <10212643@qq.com>',
      to: email,
      subject: '仙宝心灵成长 - 登录验证码',
      html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;">
        <h2 style="color:#7c3aed;">登录验证码</h2>
        <p style="color:#555;line-height:1.6;">你的登录验证码为：</p>
        <div style="font-size:36px;font-weight:700;letter-spacing:8px;color:#7c3aed;text-align:center;padding:24px 0;background:#f5f3ff;border-radius:12px;margin:16px 0;">${code}</div>
        <p style="color:#999;font-size:12px;">验证码5分钟内有效，如非本人操作请忽略。</p>
      </div>`
    });

    res.json({ success: true, message: '验证码已发送到邮箱' });
  } catch (error) {
    console.error('发送验证码失败:', error);
    res.status(500).json({ success: false, error: '服务器错误' });
  }
});

// ===== 验证码登录/注册 =====
router.post('/login-code', async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) {
      return res.status(400).json({ success: false, error: '请填写邮箱和验证码' });
    }

    const validCode = await db.get(
      `SELECT id, code, expires_at, used FROM email_codes WHERE email = ? ORDER BY created_at DESC LIMIT 1`,
      [email]
    );

    if (!validCode) return res.status(400).json({ success: false, error: '请先获取验证码' });
    if (validCode.used) return res.status(400).json({ success: false, error: '验证码已使用' });
    if (new Date(validCode.expires_at) < new Date()) return res.status(400).json({ success: false, error: '验证码已过期，请重新获取' });
    if (validCode.code !== code) return res.status(400).json({ success: false, error: '验证码错误' });

    await db.run('UPDATE email_codes SET used = 1 WHERE id = ?', [validCode.id]);

    let user = await db.get('SELECT id, username, email, nickname, role, plan FROM users WHERE email = ?', [email]);

    if (!user) {
      // 自动注册
      let username = email.split('@')[0].replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '');
      if (!username) username = 'user';

      const exists = await db.get('SELECT id FROM users WHERE username = ?', [username]);
      if (exists) username = username + String(Math.floor(100 + Math.random() * 900));

      const randomHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
      const result = await db.run(
        `INSERT INTO users (username, email, password_hash, nickname, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
        [username, email, randomHash, username]
      );
      user = { id: result.lastID, username, email, nickname: username, role: 'user', plan: 'free' };
    }

    const token = generateToken(user);
    setTokenCookie(res, token);

    await db.run(
      `INSERT INTO user_logs (user_id, action, detail, ip, user_agent) VALUES (?, ?, ?, ?, ?)`,
      [user.id, 'login', JSON.stringify({ method: 'email_code' }), req.ip, req.headers['user-agent'] || '']
    );

    res.json({
      success: true,
      data: {
        user: { id: user.id, username: user.username, email: user.email, nickname: user.nickname, role: user.role },
        token
      }
    });
  } catch (error) {
    console.error('验证码登录失败:', error);
    res.status(500).json({ success: false, error: '服务器错误' });
  }
});

module.exports = router;
