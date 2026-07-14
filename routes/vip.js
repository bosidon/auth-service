const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

// ===== 获取 VIP 信息（当前用户） =====
router.get('/status', authenticateToken, async (req, res) => {
  try {
    const user = await db.get(
      'SELECT plan, expires_at FROM users WHERE id = ?',
      [req.user.id]
    );

    if (!user) return res.status(404).json({ success: false, error: '用户不存在' });

    const now = new Date().toISOString();
    let isVip = false;
    let expiryLabel = '';

    if (user.plan === 'vip') {
      if (!user.expires_at) {
        isVip = true;
        expiryLabel = '不限时';
      } else if (user.expires_at > now) {
        isVip = true;
        const days = Math.ceil((new Date(user.expires_at) - new Date(now)) / (1000 * 60 * 60 * 24));
        expiryLabel = `${days} 天后到期`;
      } else {
        isVip = false;
        expiryLabel = '已过期';
      }
    } else {
      expiryLabel = '免费用户';
    }

    res.json({
      success: true,
      data: {
        plan: user.plan,
        isVip,
        expiresAt: user.expires_at,
        expiryLabel
      }
    });

  } catch (error) {
    console.error('获取VIP信息失败:', error);
    res.status(500).json({ success: false, error: '服务器错误' });
  }
});

// ===== 手动升级 VIP（管理员调用） =====
router.post('/upgrade', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { userId, type } = req.body; // type: 'yearly' or 'lifetime'

    if (!userId || !type || !['yearly', 'lifetime'].includes(type)) {
      return res.status(400).json({ success: false, error: '参数无效' });
    }

    let expiresAt = null;
    let label = '';

    if (type === 'lifetime') {
      expiresAt = null;
      label = '不限时';
    } else {
      const d = new Date();
      d.setFullYear(d.getFullYear() + 1);
      expiresAt = d.toISOString();
      label = `年卡（至 ${d.toLocaleDateString('zh-CN')}）`;
    }

    await db.run(
      `UPDATE users SET plan = 'vip', expires_at = ?, updated_at = datetime('now') WHERE id = ?`,
      [expiresAt, userId]
    );

    res.json({
      success: true,
      data: { userId, plan: 'vip', expiresAt, label },
      message: `用户 #${userId} 已升级为 VIP（${label}）`
    });

  } catch (error) {
    console.error('升级VIP失败:', error);
    res.status(500).json({ success: false, error: '服务器错误' });
  }
});

// ===== 获取 VIP 定价信息（公开） =====
router.get('/plans', (req, res) => {
  res.json({
    success: true,
    data: {
      yearly: { price: 128, label: '年卡', duration: '365天' },
      lifetime: { price: 256, label: '不限时', duration: '永久' },
      features: {
        tarot: '塔罗解读 · 无限次',
        maya: '玛雅天赋 · 无限次',
        psychTest: '心理测评 · 无限次',
        reading: '灵修阅读 · 无限本精读'
      }
    }
  });
});

module.exports = router;
