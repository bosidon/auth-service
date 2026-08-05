const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../config/database');
const { authenticateToken, generateToken, setTokenCookie, clearTokenCookie } = require('../middleware/auth');

// ===== 注册 =====
router.post('/register', async (req, res) => {
  try {
    const { email, password, nickname } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: '请填写所有必填字段' });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, error: '密码至少6位' });
    }

    // 检查重复
    const existing = await db.get('SELECT id FROM users WHERE email = ?', [email]);
    if (existing) {
      return res.status(400).json({ success: false, error: '邮箱已被注册' });
    }

    // 创建用户
    const salt = bcrypt.genSaltSync(10);
    const hash = bcrypt.hashSync(password, salt);

    const result = await db.run(
      'INSERT INTO users (email, password_hash, nickname, created_at, updated_at) VALUES (?, ?, ?, datetime("now"), datetime("now"))',
      [email, hash, nickname || email.split('@')[0]]
    );

    const userId = result.lastID;

    // 生成token
    const user = { id: userId, email, nickname: nickname || email.split('@')[0] };
    const token = generateToken(user);
    setTokenCookie(res, token);

    // 记录日志
    await db.run(
      'INSERT INTO user_logs (user_id, action, detail, ip, user_agent) VALUES (?, ?, ?, ?, ?)',
      [userId, 'register', JSON.stringify({ method: 'email' }), req.ip, req.headers['user-agent'] || '']
    );

    const createdUser = await db.get('SELECT id, email, nickname, role, created_at FROM users WHERE id = ?', [userId]);

    res.json({ success: true, data: { user: createdUser, token } });

  } catch (error) {
    console.error('注册失败:', error);
    res.status(500).json({ success: false, error: '服务器错误' });
  }
});

// ===== 登录 =====
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: '请填写邮箱和密码' });
    }

    const user = await db.get('SELECT id, email, nickname, role, password_hash FROM users WHERE email = ?', [email]);

    if (!user) {
      return res.status(401).json({ success: false, error: '邮箱或密码错误' });
    }

    if (!bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ success: false, error: '邮箱或密码错误' });
    }

    const token = generateToken(user);
    setTokenCookie(res, token);

    // 记录日志
    await db.run(
      'INSERT INTO user_logs (user_id, action, detail, ip, user_agent) VALUES (?, ?, ?, ?, ?)',
      [user.id, 'login', JSON.stringify({ method: 'email' }), req.ip, req.headers['user-agent'] || '']
    );

    res.json({
      success: true,
      data: {
        user: { id: user.id, email: user.email, nickname: user.nickname, role: user.role || 'user' },
        token
      }
    });

  } catch (error) {
    console.error('登录失败:', error);
    res.status(500).json({ success: false, error: '服务器错误' });
  }
});

// ===== 修改密码（已登录状态） =====


const multer = require('multer');
const path = require('path');
const fs = require('fs');
var upDir = path.join(__dirname, '..', 'public', 'uploads');
if (!fs.existsSync(upDir)) fs.mkdirSync(upDir, { recursive: true });
var upStorage = multer.diskStorage({
  destination: function (req, file, cb) { cb(null, upDir); },
  filename: function (req, file, cb) {
    var ext = path.extname(file.originalname) || '.jpg';
    cb(null, 'avatar_' + req.user.id + '_' + Date.now() + ext);
  }
});
var upLoader = multer({ storage: upStorage, limits: { fileSize: 5 * 1024 * 1024 } });

router.post('/upload-avatar', authenticateToken, upLoader.single('avatar'), async (req, res) => {
  if (!req.file) return res.json({ success: false, error: '请选择文件' });
  var url = '/uploads/' + req.file.filename;
  await db.run('UPDATE users SET avatar_url = ?, updated_at = datetime("now") WHERE id = ?', [url, req.user.id]);
  res.json({ success: true, data: { url: url } });
});
// 绑定手机号（需验证码校验）
router.post('/bind-phone', authenticateToken, async (req, res) => {
  try {
    const { phone, code } = req.body;
    if (!phone || !code) return res.json({ success: false, error: '请填写手机号和验证码' });
    if (!/^1[3-9]\d{9}$/.test(phone)) return res.json({ success: false, error: '手机号格式不正确' });
    // 校验验证码
    const validCode = await db.get(
      `SELECT id, code, expires_at, used FROM sms_codes WHERE phone = ? ORDER BY created_at DESC LIMIT 1`,
      [phone]
    );
    if (!validCode) return res.json({ success: false, error: '请先获取验证码' });
    if (validCode.used) return res.json({ success: false, error: '验证码已使用' });
    if (new Date(validCode.expires_at) < new Date()) return res.json({ success: false, error: '验证码已过期，请重新获取' });
    if (validCode.code !== code) return res.json({ success: false, error: '验证码错误' });
    await db.run('UPDATE sms_codes SET used = 1 WHERE id = ?', [validCode.id]);
    // 检查手机号是否被其他账号占用
    const exist = await db.get('SELECT id FROM users WHERE phone = ? AND id != ?', [phone, req.user.id]);
    if (exist) return res.json({ success: false, error: '该手机号已被其他账号绑定' });
    await db.run('UPDATE users SET phone = ?, updated_at = datetime("now") WHERE id = ?', [phone, req.user.id]);
    res.json({ success: true, data: { phone } });
  } catch (e) {
    res.json({ success: false, error: '绑定失败' });
  }
});

router.post('/change-password', authenticateToken, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;

    if (!oldPassword || !newPassword) {
      return res.status(400).json({ success: false, error: '请填写旧密码和新密码' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, error: '新密码至少6位' });
    }

    // 查当前用户密码哈希
    const user = await db.get('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
    if (!user) {
      return res.status(404).json({ success: false, error: '用户不存在' });
    }

    // 验证旧密码
    if (!bcrypt.compareSync(oldPassword, user.password_hash)) {
      return res.status(403).json({ success: false, error: '旧密码错误' });
    }

    // 设新密码
    const salt = bcrypt.genSaltSync(10);
    const hash = bcrypt.hashSync(newPassword, salt);
    await db.run(
      'UPDATE users SET password_hash = ?, updated_at = datetime("now") WHERE id = ?',
      [hash, req.user.id]
    );

    // 记录日志
    await db.run(
      'INSERT INTO user_logs (user_id, action, detail, ip, user_agent) VALUES (?, ?, ?, ?, ?)',
      [req.user.id, 'change_password', JSON.stringify({}), req.ip, req.headers['user-agent'] || '']
    );

    res.json({ success: true, data: { message: '密码修改成功' } });
  } catch (error) {
    console.error('修改密码失败:', error);
    res.status(500).json({ success: false, error: '服务器错误' });
  }
});

// ===== 退出登录 =====
router.post('/logout', authenticateToken, async (req, res) => {
  try {
    await db.run(
      'INSERT INTO user_logs (user_id, action, ip, user_agent) VALUES (?, ?, ?, ?)',
      [req.user.id, 'logout', req.ip, req.headers['user-agent'] || '']
    );
  } catch (e) {}

  clearTokenCookie(res);
  res.json({ success: true, data: { message: '已退出登录' } });
});

// ===== 获取当前用户 =====
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const user = await db.get(
      'SELECT id, email, nickname, role, avatar_url, phone, created_at FROM users WHERE id = ?',
      [req.user.id]
    );

    if (!user) {
      return res.status(404).json({ success: false, error: '用户不存在' });
    }

    res.json({ success: true, data: user });
  } catch (error) {
    console.error('获取用户失败:', error);
    res.status(500).json({ success: false, error: '服务器错误' });
  }
});

// ===== 记录操作日志（各站调用） =====
router.post('/log', authenticateToken, async (req, res) => {
  try {
    const { action, detail } = req.body;
    const validActions = ['assessment', 'tarot', 'reading', 'maya', 'portal'];

    if (!action || !validActions.includes(action)) {
      return res.status(400).json({ success: false, error: '无效的操作类型' });
    }

    await db.run(
      'INSERT INTO user_logs (user_id, action, detail, ip, user_agent) VALUES (?, ?, ?, ?, ?)',
      [req.user.id, action, detail ? JSON.stringify(detail) : null, req.ip, req.headers['user-agent'] || '']
    );

    res.json({ success: true, data: { message: '已记录' } });
  } catch (error) {
    console.error('记录日志失败:', error);
    res.status(500).json({ success: false, error: '服务器错误' });
  }
});


// ===== 验证token（供其他站调用） =====
router.post("/verify", async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.json({ success: false, error: "缺少token" });
    }
    
    const jwt = require("jsonwebtoken");
    const JWT_SECRET = process.env.JWT_SECRET;
    
    const decoded = jwt.verify(token, JWT_SECRET);
    
    // 查数据库获取完整用户信息
    const user = await db.get(
      "SELECT id, email, nickname, role, plan FROM users WHERE id = ?",
      [decoded.id]
    );
    
    if (!user) {
      return res.json({ success: false, error: "用户不存在" });
    }
    
    res.json({ success: true, user });
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return res.json({ success: false, error: "token已过期" });
    }
    res.json({ success: false, error: "token无效" });
  }
});

module.exports = router;
