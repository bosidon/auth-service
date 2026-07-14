const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../config/database');

const JWT_SECRET = process.env.JWT_SECRET;

async function sendResetEmail(email, token) {
  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '465'),
    secure: true,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  var resetUrl = 'https://auth.xianbao.online/reset-password?token=' + token;
  await transporter.sendMail({
    from: process.env.SMTP_FROM || '仙宝心灵成长 <10212643@qq.com>',
    to: email,
    subject: '仙宝心灵成长 - 重置密码',
    html: '<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;">' +
      '<h2 style="color:#7c3aed;">重置密码</h2>' +
      '<p style="color:#555;line-height:1.6;">你请求了密码重置，点击下方按钮设置新密码：</p>' +
      '<a href="' + resetUrl + '" style="display:inline-block;padding:12px 24px;background:#7c3aed;color:white;text-decoration:none;border-radius:8px;margin:16px 0;">重置密码</a>' +
      '<p style="color:#999;font-size:12px;">此链接30分钟内有效。如非本人操作请忽略。</p></div>'
  });
}

// 请求重置密码
router.post('/request', async (req, res) => {
  try {
    var email = req.body.email;
    if (!email) return res.status(400).json({ success: false, error: '请输入邮箱' });
    var user = await db.get('SELECT id, email FROM users WHERE email = ?', [email]);
    if (!user) return res.json({ success: true, message: '如果该邮箱已注册，重置链接已发送' });
    var token = crypto.randomBytes(32).toString('hex');
    var expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    await db.run('INSERT INTO password_resets (user_id, token, expires_at) VALUES (?, ?, ?)', [user.id, token, expiresAt]);
    await sendResetEmail(user.email, token);
    res.json({ success: true, message: '如果该邮箱已注册，重置链接已发送' });
  } catch (error) {
    console.error('请求重置密码失败:', error);
    res.status(500).json({ success: false, error: '服务器错误' });
  }
});

// 验证 token
router.post('/verify', async (req, res) => {
  try {
    var token = req.body.token;
    if (!token) return res.json({ valid: false });
    var reset = await db.get('SELECT expires_at, used FROM password_resets WHERE token = ?', [token]);
    if (!reset || reset.used || new Date(reset.expires_at) < new Date()) return res.json({ valid: false });
    res.json({ valid: true });
  } catch (error) {
    res.json({ valid: false });
  }
});

// 重置密码
router.post('/reset', async (req, res) => {
  try {
    var token = req.body.token;
    var password = req.body.password;
    if (!token || !password) return res.status(400).json({ success: false, error: '参数无效' });
    if (password.length < 6) return res.status(400).json({ success: false, error: '密码至少6位' });
    var reset = await db.get('SELECT id, user_id, expires_at, used FROM password_resets WHERE token = ?', [token]);
    if (!reset) return res.status(400).json({ success: false, error: '无效的重置链接' });
    if (reset.used) return res.status(400).json({ success: false, error: '此链接已使用' });
    if (new Date(reset.expires_at) < new Date()) return res.status(400).json({ success: false, error: '链接已过期' });
    var hash = await bcrypt.hash(password, 10);
    await db.run("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?", [hash, reset.user_id]);
    await db.run('UPDATE password_resets SET used = 1 WHERE id = ?', [reset.id]);

    var user = await db.get('SELECT id, username, email, role FROM users WHERE id = ?', [reset.user_id]);
    var jwtToken = jwt.sign({ id: user.id, username: user.username, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });

    res.json({ success: true, token: jwtToken, user: user });
  } catch (error) {
    console.error('重置密码失败:', error);
    res.status(500).json({ success: false, error: '服务器错误' });
  }
});

module.exports = router;
