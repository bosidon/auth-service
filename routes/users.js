const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

// ===== 获取用户操作日志 =====
router.get('/logs', authenticateToken, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;

    const logs = await db.query(
      'SELECT id, action, detail, ip, created_at FROM user_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [req.user.id, limit, offset]
    );

    const countRow = await db.get('SELECT COUNT(*) as c FROM user_logs WHERE user_id = ?', [req.user.id]);

    res.json({
      success: true,
      data: { logs, total: countRow.c, page, limit }
    });

  } catch (error) {
    console.error('获取日志失败:', error);
    res.status(500).json({ success: false, error: '服务器错误' });
  }
});

// ===== 更新个人信息 =====
router.patch('/profile', authenticateToken, async (req, res) => {
  try {
    const { nickname } = req.body;

    if (nickname !== undefined) {
      await db.run(
        'UPDATE users SET nickname = ?, updated_at = datetime("now") WHERE id = ?',
        [nickname, req.user.id]
      );
    }

    const user = await db.get(
      'SELECT id, username, email, nickname, plan, avatar_url, created_at FROM users WHERE id = ?',
      [req.user.id]
    );

    res.json({ success: true, data: user });
  } catch (error) {
    console.error('更新失败:', error);
    res.status(500).json({ success: false, error: '服务器错误' });
  }
});


// ===== 管理员：获取用户列表 =====
router.get('/', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = (page - 1) * limit;
    const search = req.query.search || '';

    let whereClause = '';
    const params = [];
    if (search) {
      whereClause = 'WHERE username LIKE ? OR email LIKE ? OR nickname LIKE ?';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    const users = await db.query(
      'SELECT id, username, email, nickname, role, plan, expires_at, avatar_url, created_at, updated_at FROM users ' +
      whereClause + ' ORDER BY id ASC LIMIT ? OFFSET ?',
      [...params, limit, offset]
    );

    const countRow = await db.get(
      'SELECT COUNT(*) as c FROM users ' + whereClause, params
    );

    res.json({
      success: true,
      data: { users, total: countRow.c, page, limit }
    });

  } catch (error) {
    console.error('获取用户列表失败:', error);
    res.status(500).json({ success: false, error: '服务器错误' });
  }
});

// ===== 管理员：修改用户角色 =====
router.patch('/:id/role', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const { role } = req.body;

    if (!role || !['user', 'admin'].includes(role)) {
      return res.status(400).json({ success: false, error: '角色无效，仅支持 user / admin' });
    }

    if (userId === req.user.id) {
      return res.status(400).json({ success: false, error: '不能修改自己的角色' });
    }

    const result = await db.run(
      `UPDATE users SET role = ?, updated_at = datetime('now') WHERE id = ?`,
      [role, userId]
    );

    if (result.changes === 0) {
      return res.status(404).json({ success: false, error: '用户不存在' });
    }

    const user = await db.get(
      'SELECT id, username, email, nickname, role, plan, created_at FROM users WHERE id = ?',
      [userId]
    );

    res.json({ success: true, data: user, message: '角色已更新' });

  } catch (error) {
    console.error('更新角色失败:', error);
    res.status(500).json({ success: false, error: '服务器错误' });
  }
});

// ===== 管理员：修改用户套餐 =====
router.patch('/:id/plan', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const { plan } = req.body;

    if (!plan || !['free', 'yearly', 'lifetime'].includes(plan)) {
      return res.status(400).json({ success: false, error: '套餐无效，仅支持 free / yearly / lifetime' });
    }

    let expiresAt = null;
    if (plan === 'yearly') {
      const d = new Date(); d.setFullYear(d.getFullYear() + 1); expiresAt = d.toISOString();
    }

    const dbPlan = plan === 'free' ? 'free' : 'vip';

    await db.run(
      "UPDATE users SET plan = ?, expires_at = ?, updated_at = datetime('now') WHERE id = ?",
      [dbPlan, expiresAt, userId]
    );

    const user = await db.get(
      'SELECT id, username, email, nickname, role, plan, expires_at, created_at FROM users WHERE id = ?',
      [userId]
    );

    res.json({ success: true, data: user, message: '套餐已更新' });
  } catch (error) {
    console.error('更新套餐失败:', error);
    res.status(500).json({ success: false, error: '服务器错误' });
  }
});

// ===== 管理员：续卡（仅年卡用户，在当前到期日+1年） =====
router.post('/:id/renew', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);

    const user = await db.get('SELECT plan, expires_at FROM users WHERE id = ?', [userId]);
    if (!user) return res.status(404).json({ success: false, error: '用户不存在' });
    if (user.plan !== 'vip' || !user.expires_at) {
      return res.status(400).json({ success: false, error: '仅年卡用户可续卡' });
    }

    const currentExp = new Date(user.expires_at);
    currentExp.setFullYear(currentExp.getFullYear() + 1);
    const newExpiresAt = currentExp.toISOString();

    await db.run(
      "UPDATE users SET expires_at = ?, updated_at = datetime('now') WHERE id = ?",
      [newExpiresAt, userId]
    );

    const updated = await db.get(
      'SELECT id, username, email, nickname, role, plan, expires_at, created_at FROM users WHERE id = ?',
      [userId]
    );

    res.json({ success: true, data: updated, message: '续卡成功' });
  } catch (error) {
    console.error('续卡失败:', error);
    res.status(500).json({ success: false, error: '服务器错误' });
  }
});

module.exports = router;
