const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

// 默认免费限制
const DEFAULT_LIMITS = { tarot: 20, maya: 3, psych_test: 3, reading: 3 };

// 获取免费限制（从 DB 读取，没有则返回默认值）
async function getFreeLimits() {
  const row = await db.get("SELECT value FROM settings WHERE key = 'free_limits'");
  if (row) {
    try { return JSON.parse(row.value); } catch (e) { return { ...DEFAULT_LIMITS }; }
  }
  // 写入默认值
  const json = JSON.stringify(DEFAULT_LIMITS);
  await db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('free_limits', ?)", [json]);
  return { ...DEFAULT_LIMITS };
}

// ===== 获取免费次数设置（管理员） =====
router.get('/', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const limits = await getFreeLimits();
    res.json({ success: true, data: limits });
  } catch (error) {
    console.error('获取设置失败:', error);
    res.status(500).json({ success: false, error: '服务器错误' });
  }
});

// ===== 更新免费次数设置（管理员） =====
router.put('/', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { limits } = req.body;
    const validServices = ['tarot', 'maya', 'psych_test', 'reading'];

    if (!limits || typeof limits !== 'object') {
      return res.status(400).json({ success: false, error: '参数无效' });
    }

    for (const s of validServices) {
      if (limits[s] !== undefined) {
        const v = parseInt(limits[s]);
        if (isNaN(v) || v < 0 || v > 999) {
          return res.status(400).json({ success: false, error: `${s} 次数无效（0-999）` });
        }
      }
    }

    const current = await getFreeLimits();
    const merged = { ...current, ...limits };

    // 只保留合法服务
    const cleaned = {};
    for (const s of validServices) {
      cleaned[s] = merged[s] !== undefined ? parseInt(merged[s]) : (current[s] || 0);
    }

    await db.run(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('free_limits', ?, datetime('now'))",
      [JSON.stringify(cleaned)]
    );

    res.json({ success: true, data: cleaned, message: '免费次数已更新' });
  } catch (error) {
    console.error('更新设置失败:', error);
    res.status(500).json({ success: false, error: '服务器错误' });
  }
});

module.exports = { router, getFreeLimits };
