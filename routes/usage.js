const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

// 各服务免费版用量上限
// 从 DB settings 读取
async function getFreeLimits() {
  const row = await db.get("SELECT value FROM settings WHERE key = 'free_limits'");
  if (row) {
    try { return JSON.parse(row.value); } catch(e) {}
  }
  return { tarot: 20, maya: 3, psych_test: 3, reading: 3 };
}

// ===== VIP 到期检查与自动降级 =====
async function getEffectivePlan(userId) {
  const user = await db.get('SELECT plan, expires_at FROM users WHERE id = ?', [userId]);
  if (!user) return 'free';
  if (user.plan !== 'vip' || !user.expires_at) return user.plan || 'free';
  if (user.expires_at < new Date().toISOString()) {
    await db.run("UPDATE users SET plan = 'free' WHERE id = ?", [userId]);
    console.log('  User #' + userId + ' VIP expired, downgraded to free');
    return 'free';
  }
  return 'vip';
}

// ===== 获取用量上限定义 =====
router.get('/limits', async (req, res) => {
  const limits = await getFreeLimits();
  res.json({ success: true, data: limits });
});

// ===== 获取当前用户用量 =====
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const plan = await getEffectivePlan(userId);

    const usageRows = await db.query(
      'SELECT service, used FROM usage WHERE user_id = ?',
      [userId]
    );

    const usageMap = {};
    usageRows.forEach(r => { usageMap[r.service] = r.used; });

    const limits = await getFreeLimits();
    const limitsA = await getFreeLimits();
    const services = ['tarot', 'maya', 'psych_test', 'reading'];
    const result = services.map(s => {
      const used = usageMap[s] || 0;
      const limit = plan === 'vip' ? -1 : (limits[s] || 0);
      return {
        service: s,
        used,
        limit,
        remaining: limit === -1 ? -1 : Math.max(0, limit - used),
        unlimited: limit === -1
      };
    });

    res.json({ success: true, data: { plan, usage: result } });
  } catch (error) {
    console.error('获取用量失败:', error);
    res.status(500).json({ success: false, error: '服务器错误' });
  }
});

// ===== 检查是否可用（不递增） =====
router.get('/check', authenticateToken, async (req, res) => {
  try {
    const { service } = req.query;
    const limitsC = await getFreeLimits(); if (!service || !limitsC[service]) {
      return res.status(400).json({ success: false, error: '无效的服务名称' });
    }

    const plan = await getEffectivePlan(req.user.id);
    if (plan === 'vip') {
      return res.json({ success: true, data: { allowed: true, remaining: -1, unlimited: true } });
    }

    const row = await db.get(
      'SELECT used FROM usage WHERE user_id = ? AND service = ?',
      [req.user.id, service]
    );
    const used = row ? row.used : 0;
    const limit = limitsC[service];
    const remaining = Math.max(0, limit - used);

    res.json({
      success: true,
      data: { allowed: remaining > 0, used, limit, remaining }
    });
  } catch (error) {
    console.error('检查用量失败:', error);
    res.status(500).json({ success: false, error: '服务器错误' });
  }
});

// ===== 递增用量（消耗一次机会） =====
router.post('/increment', authenticateToken, async (req, res) => {
  try {
    const { service, count = 1 } = req.body;
    console.log('[INCREMENT] ' + new Date().toISOString() + ' ' + service + ' user=' + req.user.id + ' count=' + count);
    const limitsC = await getFreeLimits(); if (!service || !limitsC[service]) {
      return res.status(400).json({ success: false, error: '无效的服务名称' });
    }

    const userId = req.user.id;
    const plan = await getEffectivePlan(userId);

    // VIP 不限量：跳过限制检查但继续计数（用于统计）
    const isVip = plan === 'vip';

    // 非VIP用户检查用量上限
    if (!isVip) {
      const row = await db.get(
        'SELECT used FROM usage WHERE user_id = ? AND service = ?',
        [userId, service]
      );
      const used = row ? row.used : 0;
      const limit = limitsC[service];
      if (used + count > limit) {
        return res.status(403).json({
          success: false,
          error: `免费版 ${service} 服务已用尽`
        });
      }
    }

    // 所有用户都计数（包括VIP，用于统计）
    const row = await db.get(
      'SELECT used FROM usage WHERE user_id = ? AND service = ?',
      [userId, service]
    );
    if (row) {
      await db.run(
        `UPDATE usage SET used = used + ${count}, updated_at = datetime('now') WHERE user_id = ? AND service = ?`,
        [userId, service]
      );
    } else {
      await db.run(
        'INSERT INTO usage (user_id, service, used) VALUES (?, ?, ?)',
        [userId, service, count]
      );
    }
    const newUsed = row ? row.used + count : count;

    if (isVip) {
      return res.json({ success: true, data: { allowed: true, used: newUsed, remaining: -1, unlimited: true } });
    }

    const limit = limitsC[service];
    const remaining = Math.max(0, limit - newUsed);

    res.json({
      success: true,
      data: { allowed: remaining > 0, used: newUsed, limit, remaining }
    });

  } catch (error) {
    console.error('递增用量失败:', error);
    res.status(500).json({ success: false, error: '服务器错误' });
  }
});

// ===== 管理员：获取指定用户用量 =====
router.get('/admin', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const userId = parseInt(req.query.user_id);
    if (!userId) {
      return res.status(400).json({ success: false, error: '缺少 user_id' });
    }

    const user = await db.get('SELECT id, plan FROM users WHERE id = ?', [userId]);
    if (!user) {
      return res.status(404).json({ success: false, error: '用户不存在' });
    }

    const plan = await getEffectivePlan(userId);
    const usageRows = await db.query(
      'SELECT service, used FROM usage WHERE user_id = ?',
      [userId]
    );

    const usageMap = {};
    usageRows.forEach(r => { usageMap[r.service] = r.used; });

    const limits = await getFreeLimits();
    const limitsA = await getFreeLimits();
    const services = ['tarot', 'maya', 'psych_test', 'reading'];
    const result = services.map(s => {
      const used = usageMap[s] || 0;
      const limit = plan === 'vip' ? -1 : (limits[s] || 0);
      return {
        service: s,
        used,
        limit,
        remaining: limit === -1 ? -1 : Math.max(0, limit - used),
        unlimited: limit === -1
      };
    });

    res.json({ success: true, data: { plan, usage: result } });
  } catch (error) {
    console.error('获取用户用量失败:', error);
    res.status(500).json({ success: false, error: '服务器错误' });
  }
});

// ===== 管理员：用量统计汇总 =====
router.get('/stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const totalRows = await db.query(
      "SELECT service, SUM(used) as total FROM usage GROUP BY service ORDER BY service"
    );
    
    const userCounts = await db.query(
      "SELECT COUNT(DISTINCT user_id) as c FROM usage"
    );
    
    const topUsers = await db.query(
      "SELECT u.id, u.username, u.email, SUM(us.used) as total_usage FROM usage us JOIN users u ON u.id = us.user_id GROUP BY us.user_id ORDER BY total_usage DESC LIMIT 5"
    );

    const services = ['tarot', 'maya', 'psych_test', 'reading'];
    const serviceLabels = { tarot: '塔罗', maya: '玛雅', psych_test: '测评', reading: '阅读' };
    const usageMap = {};
    totalRows.forEach(r => { usageMap[r.service] = r.total; });
    
    const stats = services.map(s => ({
      service: s,
      label: serviceLabels[s] || s,
      total: parseInt(usageMap[s] || 0)
    }));

    res.json({
      success: true,
      data: {
        stats,
        activeUsers: userCounts[0]?.c || 0,
        topUsers: topUsers.map(u => ({
          id: u.id,
          username: u.username,
          email: u.email,
          totalUsage: u.total_usage
        }))
      }
    });
  } catch (error) {
    console.error('获取用量统计失败:', error);
    res.status(500).json({ success: false, error: '服务器错误' });
  }
});

module.exports = router;
