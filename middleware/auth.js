require("dotenv").config({ path: "/var/www/.env" });
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET not set in .env');
  process.exit(1);
}
const JWT_EXPIRES = '30d';
const COOKIE_DOMAIN = '.xianbao.online';
const COOKIE_NAME = 'xianbao_token';

// JWT认证中间件
function authenticateToken(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME] || 
                req.headers['authorization']?.split(' ')[1];

  if (!token) {
    return res.status(401).json({
      success: false,
      error: '未登录'
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: '登录已过期，请重新登录'
      });
    }
    return res.status(403).json({
      success: false,
      error: '无效的登录凭证'
    });
  }
}

// 可选认证（不强制）
function optionalAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME] ||
                req.headers['authorization']?.split(' ')[1];

  if (!token) {
    req.user = null;
    return next();
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET);
  } catch {
    req.user = null;
  }
  next();
}

// 生成JWT
function generateToken(user) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      email: user.email,
      nickname: user.nickname || user.username,
      plan: user.plan || 'free',
      role: user.role || 'user'
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

// 设置Cookie
function setTokenCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    domain: COOKIE_DOMAIN,
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000 // 30天
  });
}

// 清除Cookie
function clearTokenCookie(res) {
  res.clearCookie(COOKIE_NAME, {
    domain: COOKIE_DOMAIN,
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'lax'
  });
}

// 管理员权限中间件
function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ success: false, error: '未登录' });
  }
  if (req.user.role !== 'admin') {
    return res.status(403).json({ success: false, error: '需要管理员权限' });
  }
  next();
}

module.exports = {
  authenticateToken,
  optionalAuth,
  requireAdmin,
  generateToken,
  setTokenCookie,
  clearTokenCookie,
  JWT_SECRET,
  COOKIE_NAME
};
