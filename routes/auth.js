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
    const { email, password, phone } = req.body;

    if ((!email && !phone) || !password) {
      return res.status(400).json({ success: false, error: '请填写账号和密码' });
    }

    const user = phone
      ? await db.get('SELECT id, email, nickname, role, password_hash FROM users WHERE phone = ?', [phone])
      : await db.get('SELECT id, email, nickname, role, password_hash FROM users WHERE email = ?', [email]);

    if (!user) {
      return res.status(401).json({ success: false, error: '账号或密码错误' });
    }

    if (!bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ success: false, error: '账号或密码错误' });
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

// 绑定邮箱（需邮箱验证码校验）
router.post('/bind-email', authenticateToken, async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.json({ success: false, error: '请填写邮箱和验证码' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.json({ success: false, error: '邮箱格式不正确' });
    // 校验验证码
    const validCode = await db.get(
      `SELECT id, code, expires_at, used FROM email_codes WHERE email = ? ORDER BY created_at DESC LIMIT 1`,
      [email]
    );
    if (!validCode) return res.json({ success: false, error: '请先获取验证码' });
    if (validCode.used) return res.json({ success: false, error: '验证码已使用' });
    if (new Date(validCode.expires_at) < new Date()) return res.json({ success: false, error: '验证码已过期，请重新获取' });
    if (validCode.code !== code) return res.json({ success: false, error: '验证码错误' });
    await db.run('UPDATE email_codes SET used = 1 WHERE id = ?', [validCode.id]);
    // 邮箱唯一检查（排除自己）
    const exist = await db.get('SELECT id FROM users WHERE email = ? AND id != ?', [email, req.user.id]);
    if (exist) return res.json({ success: false, error: '该邮箱已被其他账号使用' });
    await db.run('UPDATE users SET email = ?, updated_at = datetime("now") WHERE id = ?', [email, req.user.id]);
    res.json({ success: true, data: { email } });
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

// ===== 验证码修改/设置密码（已登录，方案B：验证码验证后直接设新密码） =====
router.post('/change-password-code', authenticateToken, async (req, res) => {
  try {
    const { phone, email, code, newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ success: false, error: '密码至少6位' });
    }
    // 校验验证码（手机号或邮箱）
    if (phone) {
      const validCode = await db.get(
        `SELECT id, code, expires_at, used FROM sms_codes WHERE phone = ? ORDER BY created_at DESC LIMIT 1`,
        [phone]
      );
      if (!validCode) return res.json({ success: false, error: '请先获取验证码' });
      if (validCode.used) return res.json({ success: false, error: '验证码已使用' });
      if (new Date(validCode.expires_at) < new Date()) return res.json({ success: false, error: '验证码已过期，请重新获取' });
      if (validCode.code !== code) return res.json({ success: false, error: '验证码错误' });
      await db.run('UPDATE sms_codes SET used = 1 WHERE id = ?', [validCode.id]);
    } else if (email) {
      const validCode = await db.get(
        `SELECT id, code, expires_at, used FROM email_codes WHERE email = ? ORDER BY created_at DESC LIMIT 1`,
        [email]
      );
      if (!validCode) return res.json({ success: false, error: '请先获取验证码' });
      if (validCode.used) return res.json({ success: false, error: '验证码已使用' });
      if (new Date(validCode.expires_at) < new Date()) return res.json({ success: false, error: '验证码已过期，请重新获取' });
      if (validCode.code !== code) return res.json({ success: false, error: '验证码错误' });
      await db.run('UPDATE email_codes SET used = 1 WHERE id = ?', [validCode.id]);
    } else {
      return res.json({ success: false, error: '请提供手机号或邮箱' });
    }
    // 设置新密码
    const salt = bcrypt.genSaltSync(10);
    const hash = bcrypt.hashSync(newPassword, salt);
    await db.run(
      'UPDATE users SET password_hash = ?, updated_at = datetime("now") WHERE id = ?',
      [hash, req.user.id]
    );
    await db.run(
      'INSERT INTO user_logs (user_id, action, detail, ip, user_agent) VALUES (?, ?, ?, ?, ?)',
      [req.user.id, 'change_password', JSON.stringify({ method: 'code' }), req.ip, req.headers['user-agent'] || '']
    );
    res.json({ success: true, data: { message: '密码已更新' } });
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


// 取消绑定（微信/手机/邮箱——至少保留一种登录方式）
router.delete('/bindings/:provider', authenticateToken, async (req, res) => {
  try {
    const provider = req.params.provider;
    const userId = req.user.id;
    if (!['wechat', 'phone', 'email'].includes(provider)) {
      return res.json({ success: false, error: '不支持的绑定类型' });
    }
    const u = await db.get('SELECT email, phone FROM users WHERE id = ?', [userId]);
    if (!u) return res.json({ success: false, error: '用户不存在' });

    // 虚拟邮箱不可解绑（自动生成的登录标识）
    if (provider === 'email' && u.email && (u.email.indexOf('@wechat.local') > -1 || u.email.indexOf('@sms.local') > -1)) {
      return res.json({ success: false, error: '虚拟邮箱不可解绑' });
    }
    const wxBind = await db.get("SELECT id FROM user_bindings WHERE user_id = ? AND provider = 'wechat'", [userId]);

    // 解绑后剩余登录方式计数
    let remaining = 0;
    if (provider !== 'email' && u.email && u.email.indexOf('@wechat.local') === -1 && u.email.indexOf('@sms.local') === -1) remaining++;
    if (provider !== 'phone' && u.phone) remaining++;
    if (provider !== 'wechat' && wxBind) remaining++;
    if (remaining === 0) return res.json({ success: false, error: '至少保留一种登录方式' });

    if (provider === 'wechat') {
      await db.run("DELETE FROM user_bindings WHERE user_id = ? AND provider = 'wechat'", [userId]);
    } else if (provider === 'phone') {
      await db.run('UPDATE users SET phone = NULL WHERE id = ?', [userId]);
    } else {
      await db.run('UPDATE users SET email = NULL WHERE id = ?', [userId]);
    }
    res.json({ success: true });
  } catch (e) {
    console.error('取消绑定失败:', e.message);
    res.json({ success: false, error: '解绑失败' });
  }
});


// ========== 灵修站用户数据 API ==========

// GET /api/auth/preferences - 获取阅读偏好
router.get('/preferences', authenticateToken, async (req, res) => {
  try {
    let pref = await db.get('SELECT * FROM user_preferences WHERE user_id = ?', [req.user.id]);
    if (!pref) {
      await db.run('INSERT INTO user_preferences (user_id) VALUES (?)', [req.user.id]);
      pref = { font_size: 18, color_theme: 'dark' };
    }
    res.json({ success: true, data: { font_size: pref.font_size, color_theme: pref.color_theme } });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// POST /api/auth/preferences - 保存阅读偏好
router.post('/preferences', authenticateToken, async (req, res) => {
  const { font_size, color_theme } = req.body;
  try {
    const existing = await db.get('SELECT font_size, color_theme FROM user_preferences WHERE user_id = ?', [req.user.id]);
    const curFs = font_size != null ? font_size : (existing ? existing.font_size : 18);
    const curCt = color_theme != null ? color_theme : (existing ? existing.color_theme : 'dark');
    await db.run(`INSERT INTO user_preferences (user_id, font_size, color_theme, updated_at)
      VALUES (?, ?, ?, datetime('now','localtime'))
      ON CONFLICT(user_id) DO UPDATE SET
        font_size=?, color_theme=?, updated_at=datetime('now','localtime')`,
      [req.user.id, curFs, curCt, curFs, curCt]);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// GET /api/auth/reading/progress - 获取阅读历史
router.get('/reading/progress', authenticateToken, async (req, res) => {
  try {
    const rows = await db.query(`
      SELECT rp.book_id, rp.chapter_id, rp.progress, rp.updated_at as last_read_at
      FROM reading_progress rp
      WHERE rp.user_id = ?
      ORDER BY rp.updated_at DESC
      LIMIT 20
    `, [req.user.id]);
    res.json({ success: true, data: rows });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// POST /api/auth/reading/progress - 保存阅读进度
router.post('/reading/progress', authenticateToken, async (req, res) => {
  const { book_id, chapter_id, progress } = req.body;
  if (!book_id || !chapter_id) return res.json({ success: false, error: '缺少参数' });
  try {
    await db.run(`
      INSERT INTO reading_progress (user_id, book_id, chapter_id, progress, updated_at)
      VALUES (?, ?, ?, ?, datetime('now','localtime'))
      ON CONFLICT(user_id, book_id) DO UPDATE SET
        chapter_id=?, progress=coalesce(?,progress), updated_at=datetime('now','localtime')
    `, [req.user.id, book_id, chapter_id, progress||0, chapter_id, progress||0]);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});


// ========== 心理测评用户数据 API ==========

// POST /api/auth/psych/result - 创建测评结果+答案
router.post("/psych/result", authenticateToken, async (req, res) => {
  const { assessment_id, total_score, result_summary, result_details, answers: ansArr } = req.body;
  if (!assessment_id || !ansArr || !Array.isArray(ansArr)) {
    return res.json({ success: false, error: "参数不完整" });
  }
  try {
    const sr = await db.run(
      "INSERT INTO assessment_results (user_id, assessment_id, start_time, total_score, result_summary, result_details) VALUES (?, ?, datetime('now','localtime'), ?, ?, ?)",
      [req.user.id, assessment_id, total_score || 0, result_summary || "测评完成", result_details || null]
    );
    const resultId = sr.lastID;
    for (const a of ansArr) {
      await db.run(
        "INSERT INTO answers (result_id, question_id, answer_value, answered_at) VALUES (?, ?, ?, datetime('now','localtime'))",
        [resultId, a.questionId, a.answerValue]
      );
    }
    res.json({ success: true, data: { resultId } });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// PUT /api/auth/psych/result/:id - 更新测评结果
router.put("/psych/result/:id", authenticateToken, async (req, res) => {
  const { total_score, result_summary, result_details } = req.body;
  try {
    await db.run(
      "UPDATE assessment_results SET total_score=?, result_summary=?, result_details=?, end_time=datetime('now','localtime') WHERE id=? AND user_id=?",
      [total_score, result_summary, result_details, req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// GET /api/auth/psych/results - 当前用户测评历史
router.get("/psych/results", authenticateToken, async (req, res) => {
  try {
    const rows = await db.query(
      "SELECT ar.id, ar.assessment_id, ar.start_time, ar.end_time, ar.total_score, ar.result_summary, ar.result_details FROM assessment_results ar WHERE ar.user_id = ? AND ar.result_summary IS NOT NULL ORDER BY ar.start_time DESC",
      [req.user.id]
    );
    res.json({ success: true, data: rows });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// GET /api/auth/psych/result/:id - 获取单条结果+答案
router.get("/psych/result/:id", authenticateToken, async (req, res) => {
  try {
    const row = await db.get("SELECT * FROM assessment_results WHERE id = ? AND user_id = ?", [req.params.id, req.user.id]);
    if (!row) return res.json({ success: false, error: "记录不存在" });
    const ans = await db.query("SELECT question_id, answer_value, score FROM answers WHERE result_id = ?", [row.id]);
    res.json({ success: true, data: Object.assign({}, row, { answers: ans }) });
  } catch(e) { res.json({ success: false, error: e.message }); }
});


// ========== 塔罗用户数据 API ==========

// POST /api/auth/tarot/reading - 保存塔罗解读
router.post("/tarot/reading", authenticateToken, async (req, res) => {
  const { question, cards, spread, questioner } = req.body;
  if (!question || !cards) return res.json({ success: false, error: "参数不完整" });
  try {
    const sr = await db.run(
      "INSERT INTO readings (user_id, username, question, questioner, spread, cards_json, interpretation) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [req.user.id, req.user.nickname || "", question, questioner || "", spread || "single", typeof cards === "string" ? cards : JSON.stringify(cards), req.body.interpretation || ""]
    );
    res.json({ success: true, data: { id: sr.lastID } });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// PUT /api/auth/tarot/reading/:id - 更新解读内容
router.put("/tarot/reading/:id", authenticateToken, async (req, res) => {
  const { interpretation } = req.body;
  try {
    await db.run("UPDATE readings SET interpretation=? WHERE id=? AND user_id=?", [interpretation, req.params.id, req.user.id]);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// GET /api/auth/tarot/readings - 获取用户解读列表
router.get("/tarot/readings", authenticateToken, async (req, res) => {
  try {
    const rows = await db.query("SELECT * FROM readings WHERE user_id = ? ORDER BY created_at DESC", [req.user.id]);
    res.json({ success: true, data: rows });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// GET /api/auth/tarot/reading/:id - 获取单条解读
router.get("/tarot/reading/:id", authenticateToken, async (req, res) => {
  try {
    const row = await db.get("SELECT * FROM readings WHERE id = ? AND user_id = ?", [req.params.id, req.user.id]);
    if (!row) return res.json({ success: false, error: "记录不存在" });
    res.json({ success: true, data: row });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ========== 心声留言用户数据 API ==========

// POST /api/auth/message - 发表留言
router.post("/message", authenticateToken, async (req, res) => {
  const { title, content, category } = req.body;
  if (!content) return res.json({ success: false, error: "内容不能为空" });
  try {
    const sr = await db.run(
      "INSERT INTO messages (user_id, username, nickname, avatar_url, title, content, category) VALUES (?,?,?,?,?,?,?)",
      [req.user.id, req.user.nickname || "", req.user.nickname || "", "", title || "", content, category || "question"]
    );
    res.json({ success: true, data: { id: sr.lastID } });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// GET /api/auth/messages - 留言列表
router.get("/messages", authenticateToken, async (req, res) => {
  try {
    const rows = await db.query("SELECT m.*, COALESCE(u.nickname, m.nickname) AS display_nickname, COALESCE(u.avatar_url, m.avatar_url) AS display_avatar FROM messages m LEFT JOIN users u ON m.user_id = u.id ORDER BY m.pinned DESC, m.created_at DESC", []);
    res.json({ success: true, data: rows });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// GET /api/auth/message/:id - 留言详情+回复
router.get("/message/:id", authenticateToken, async (req, res) => {
  try {
    const m = await db.get("SELECT m.*, COALESCE(u.nickname, m.nickname) AS display_nickname FROM messages m LEFT JOIN users u ON m.user_id = u.id WHERE m.id = ?", [req.params.id]);
    if (!m) return res.json({ success: false, error: "不存在" });
    const reps = await db.query("SELECT r.*, COALESCE(u.nickname, r.nickname) AS display_nickname FROM replies r LEFT JOIN users u ON r.user_id = u.id WHERE r.message_id = ? ORDER BY r.created_at", [m.id]);
    res.json({ success: true, data: { message: m, replies: reps } });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// POST /api/auth/message/:id/reply - 回复留言
router.post("/message/:id/reply", authenticateToken, async (req, res) => {
  const { content } = req.body;
  if (!content) return res.json({ success: false, error: "请输入内容" });
  try {
    await db.run("INSERT INTO replies (message_id, user_id, username, nickname, avatar_url, content) VALUES (?,?,?,?,?,?)",
      [req.params.id, req.user.id, req.user.nickname || "", req.user.nickname || "", "", content]);
    await db.run("UPDATE messages SET reply_count = reply_count + 1 WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// POST /api/auth/message/:id/like - 点赞/取消
router.post("/message/:id/like", authenticateToken, async (req, res) => {
  try {
    const existing = await db.get("SELECT id FROM likes WHERE message_id = ? AND user_id = ?", [req.params.id, req.user.id]);
    if (existing) {
      await db.run("DELETE FROM likes WHERE message_id = ? AND user_id = ?", [req.params.id, req.user.id]);
      await db.run("UPDATE messages SET like_count = MAX(0, like_count - 1) WHERE id = ?", [req.params.id]);
      const cnt = await db.get("SELECT like_count FROM messages WHERE id = ?", [req.params.id]);
      res.json({ success: true, liked: false, like_count: cnt ? cnt.like_count : 0 });
    } else {
      await db.run("INSERT INTO likes (message_id, user_id) VALUES (?,?)", [req.params.id, req.user.id]);
      await db.run("UPDATE messages SET like_count = like_count + 1 WHERE id = ?", [req.params.id]);
      const cnt = await db.get("SELECT like_count FROM messages WHERE id = ?", [req.params.id]);
      res.json({ success: true, liked: true, like_count: cnt ? cnt.like_count : 0 });
    }
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// PUT /api/auth/message/:id - 编辑留言
router.put("/message/:id", authenticateToken, async (req, res) => {
  try {
    const msg = await db.get("SELECT user_id FROM messages WHERE id = ?", [req.params.id]);
    if (!msg) return res.json({ success: false, error: "不存在" });
    if (msg.user_id !== req.user.id && req.user.role !== "admin") return res.json({ success: false, error: "无权编辑" });
    const { title, content } = req.body;
    if (!content) return res.json({ success: false, error: "内容不能为空" });
    await db.run("UPDATE messages SET title=?, content=?, updated_at=CURRENT_TIMESTAMP WHERE id=?", [title || "", content, req.params.id]);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// DELETE /api/auth/message/:id - 删除留言
router.delete("/message/:id", authenticateToken, async (req, res) => {
  try {
    const msg = await db.get("SELECT user_id FROM messages WHERE id = ?", [req.params.id]);
    if (!msg) return res.json({ success: false, error: "不存在" });
    if (msg.user_id !== req.user.id && req.user.role !== "admin") return res.json({ success: false, error: "无权删除" });
    await db.run("DELETE FROM replies WHERE message_id = ?", [req.params.id]);
    await db.run("DELETE FROM likes WHERE message_id = ?", [req.params.id]);
    await db.run("DELETE FROM messages WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// POST /api/auth/message/:id/pin - 置顶/取消
router.post("/message/:id/pin", authenticateToken, async (req, res) => {
  if (req.user.role !== "admin") return res.json({ success: false, error: "仅管理员可操作" });
  try {
    const msg = await db.get("SELECT pinned FROM messages WHERE id = ?", [req.params.id]);
    if (!msg) return res.json({ success: false, error: "不存在" });
    const newPinned = msg.pinned ? 0 : 1;
    await db.run("UPDATE messages SET pinned = ? WHERE id = ?", [newPinned, req.params.id]);
    res.json({ success: true, pinned: newPinned === 1 });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

module.exports = router;

