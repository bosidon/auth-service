const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const path = require('path');
const { initDatabase, get: dbGet, run: dbRun } = require('./config/database');

const app = express();
const PORT = process.env.PORT || 3050;

// ===== 默认 CORS 白名单（DB 为空时的兜底） =====
const DEFAULT_CORS = [
  'https://xianbao.online',
  'https://www.xianbao.online',
  'https://auth.xianbao.online',
  'https://ceping.xianbao.online',
  'https://tarot.xianbao.online',
  'https://read.xianbao.online',
  'https://maya.xianbao.online'
];

// 动态 CORS：从 DB settings 读取，没有则用默认值
async function getCorsWhitelist() {
  try {
    const row = await dbGet("SELECT value FROM settings WHERE key = 'cors_whitelist'");
    if (row && row.value) {
      const parsed = JSON.parse(row.value);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch (e) { /* DB 未就绪 */ }
  return DEFAULT_CORS;
}

// ===== 中间件 =====
app.use(express.json());
app.use(cookieParser());

// 动态 CORS 中间件
app.use(async (req, res, next) => {
  const origin = req.headers.origin;
  const whitelist = await getCorsWhitelist();
  if (origin && whitelist.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// 静态文件（auth-widget.js等）
app.use(express.static(path.join(__dirname, 'public')));
app.get("/reset-password", (req, res) => res.sendFile(path.join(__dirname, "public", "reset-password.html")));

// ===== 数据库初始化 =====
initDatabase();

// ===== 路由 =====
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/usage', require('./routes/usage'));
app.use('/api/vip', require('./routes/vip'));
app.use('/api/settings', require('./routes/settings').router);
app.use('/api/password', require('./routes/password-reset'));

// ===== CORS 管理（管理员） =====
const { authenticateToken, requireAdmin } = require('./middleware/auth');

app.get('/api/cors', authenticateToken, requireAdmin, async (req, res) => {
  const list = await getCorsWhitelist();
  res.json({ success: true, data: list });
});

app.put('/api/cors', authenticateToken, requireAdmin, async (req, res) => {
  const { whitelist } = req.body;
  if (!Array.isArray(whitelist) || whitelist.length === 0) {
    return res.status(400).json({ success: false, error: '白名单不能为空' });
  }
  // 验证每个都是合法 URL
  for (const url of whitelist) {
    try { new URL(url); } catch {
      return res.status(400).json({ success: false, error: `无效 URL: ${url}` });
    }
  }
  await dbRun(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('cors_whitelist', ?, datetime('now'))",
    [JSON.stringify(whitelist)]
  );
  res.json({ success: true, data: whitelist, message: 'CORS 白名单已更新' });
});

// ===== 管理后台页面 =====
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ===== 健康检查 =====
app.get('/api/health', (req, res) => {
  res.json({ success: true, service: 'xianbao-auth', version: '1.0.0' });
});

// ===== 错误处理 =====
app.use((err, req, res, next) => {
  console.error('服务器错误:', err);
  res.status(500).json({ success: false, error: '服务器内部错误' });
});

// ===== 启动 =====
app.listen(PORT, () => {
  console.log(' 仙宝认证中心运行在 http://0.0.0.0:' + PORT);
});
