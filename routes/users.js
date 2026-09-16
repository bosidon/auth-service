const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const sqlite3 = require('sqlite3').verbose();

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
    const { nickname, avatar_url } = req.body;

    if (nickname !== undefined) {
      await db.run(
        'UPDATE users SET nickname = ?, updated_at = datetime("now") WHERE id = ?',
        [nickname, req.user.id]
      );
    }
    if (avatar_url !== undefined) {
      await db.run(
        'UPDATE users SET avatar_url = ?, updated_at = datetime("now") WHERE id = ?',
        [avatar_url, req.user.id]
      );
    }

    const user = await db.get(
      'SELECT id, email, nickname, plan, avatar_url, created_at FROM users WHERE id = ?',
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
      whereClause = 'WHERE u.email LIKE ? OR u.nickname LIKE ? OR u.phone LIKE ?';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    const users = await db.query(
      'SELECT u.id, u.email, u.phone, u.nickname, u.role, u.plan, u.expires_at, u.avatar_url, u.created_at, u.updated_at, ' +
      "(SELECT COUNT(*) FROM user_bindings b WHERE b.user_id = u.id AND b.provider = 'wechat') AS wechat_bound, " +
      "(SELECT json_group_array(json_object('service', s.service, 'used', s.used)) FROM usage s WHERE s.user_id = u.id) AS usage_json " +
      'FROM users u ' + whereClause.replace(/WHERE /, 'WHERE ') + ' ORDER BY u.id ASC LIMIT ? OFFSET ?',
      [...params, limit, offset]
    );

    const countRow = await db.get(
      'SELECT COUNT(*) as c FROM users ' + whereClause, params
    );

    // Parse usage_json for each user
    users.forEach(u => {
      try { u.usage = JSON.parse(u.usage_json || '[]'); } catch(e) { u.usage = []; }
      delete u.usage_json;
    });

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

    if (!role || !['user', 'admin', 'sales'].includes(role)) {
      return res.status(400).json({ success: false, error: '角色无效，仅支持 user / admin / sales' });
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
      'SELECT id, email, nickname, role, plan, created_at FROM users WHERE id = ?',
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
      'SELECT id, email, nickname, role, plan, expires_at, created_at FROM users WHERE id = ?',
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
      'SELECT id, email, nickname, role, plan, expires_at, created_at FROM users WHERE id = ?',
      [userId]
    );

    res.json({ success: true, data: updated, message: '续卡成功' });
  } catch (error) {
    console.error('续卡失败:', error);
    res.status(500).json({ success: false, error: '服务器错误' });
  }
});


// ===== 删除用户（跨库级联清理） =====
function openDbFile(p) {
  return new Promise((resolve, reject) => {
    const d = new sqlite3.Database(p, (err) => err ? reject(err) : resolve(d));
  });
}
function runDbFile(db, sql, params) {
  return new Promise((resolve, reject) => {
    db.run(sql, params || [], function(err) { err ? reject(err) : resolve(this); });
  });
}
async function deleteUserSiteData(userId) {
  // 站点本地库旧数据清理（数据已迁移 auth.db，文件/表不存在时跳过不报错）
  const fs = require('fs');
  const jobs = [
    { db: '/var/www/lingxiu/data/xianbao.db', sql: 'DELETE FROM reading_progress WHERE user_id = ?' },
    { db: '/var/www/psych-test/data/psychological_assessment.db', sql: 'DELETE FROM assessment_results WHERE user_id = ?' },
    { db: '/var/www/tarot/backend/tarot.db', sql: 'DELETE FROM readings WHERE user_id = ?' },
    { db: '/var/www/message/messages.db', sql: 'DELETE FROM likes WHERE user_id = ?' },
    { db: '/var/www/message/messages.db', sql: 'DELETE FROM replies WHERE user_id = ?' },
    { db: '/var/www/message/messages.db', sql: 'DELETE FROM messages WHERE user_id = ?' },
  ];
  for (const j of jobs) {
    if (!fs.existsSync(j.db)) continue;   // 文件不存在（数据已迁 auth.db）→ 跳过
    try {
      const d = await openDbFile(j.db);
      try { await runDbFile(d, j.sql, [userId]); } finally { d.close(); }
    } catch (e) { /* 表不存在等 → 跳过 */ }
  }
}
router.delete('/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const targetId = parseInt(req.params.id);
    if (targetId === req.user.id) return res.json({ success: false, error: '不能删除自己' });
    const user = await db.get('SELECT id FROM users WHERE id = ?', [targetId]);
    if (!user) return res.json({ success: false, error: '用户不存在' });
    await deleteUserSiteData(targetId);
    await db.run('BEGIN');
    // 迁移表级联删除（answers 通过 result_id 关联 assessment_results）
    await db.run('DELETE FROM answers WHERE result_id IN (SELECT id FROM assessment_results WHERE user_id = ?)', [targetId]);
    await db.run('DELETE FROM messages WHERE user_id = ?', [targetId]);
    await db.run('DELETE FROM replies WHERE user_id = ?', [targetId]);
    await db.run('DELETE FROM likes WHERE user_id = ?', [targetId]);
    await db.run('DELETE FROM readings WHERE user_id = ?', [targetId]);
    await db.run('DELETE FROM assessment_results WHERE user_id = ?', [targetId]);
    await db.run('DELETE FROM reading_progress WHERE user_id = ?', [targetId]);
    await db.run('DELETE FROM user_preferences WHERE user_id = ?', [targetId]);
    await db.run('DELETE FROM usage WHERE user_id = ?', [targetId]);
    await db.run('DELETE FROM user_bindings WHERE user_id = ?', [targetId]);
    await db.run('DELETE FROM user_logs WHERE user_id = ?', [targetId]);
    await db.run('DELETE FROM users WHERE id = ?', [targetId]);
    await db.run('COMMIT');
    res.json({ success: true });
  } catch (e) {
    try { await db.run('ROLLBACK'); } catch (e2) {}
    console.error('删除用户失败:', e.message);
    res.json({ success: false, error: '删除失败: ' + e.message });
  }
});

module.exports = router;

