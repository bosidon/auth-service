const express = require('express');
const router = express.Router();
const { query, get, run } = require('../config/database');
const authenticateToken = require('../middleware/auth');

// 获取已绑定的账号列表
router.get('/bindings', authenticateToken, async (req, res) => {
  try {
    const bindings = await query(
      'SELECT provider, identifier, created_at FROM user_bindings WHERE user_id = ? ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json({ success: true, data: bindings || [] });
  } catch (error) {
    res.json({ success: false, error: '获取失败' });
  }
});

// 绑定QQ（预留）
router.post('/bind/qq', authenticateToken, async (req, res) => {
  res.json({ success: false, error: 'QQ登录功能开发中' });
});

// 绑定微信（预留）
router.post('/bind/wechat', authenticateToken, async (req, res) => {
  res.json({ success: false, error: '微信登录功能开发中' });
});

// 绑定手机号（预留）
router.post('/bind/phone', authenticateToken, async (req, res) => {
  res.json({ success: false, error: '手机号绑定功能开发中' });
});

// 解绑（预留）
router.post('/unbind', authenticateToken, async (req, res) => {
  res.json({ success: false, error: '解绑功能开发中' });
});

module.exports = router;
