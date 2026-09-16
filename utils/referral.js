/**
 * 推广归因（老带新）
 * 从请求 cookie(xb_ref) / body.ref / query.ref 解析推广人 userid
 * 新用户创建后写入 users.referred_by
 */
const db = require('../config/database');

function parseRefId(req) {
  try {
    const raw = (req && req.cookies && req.cookies.xb_ref)
      || (req && req.body && req.body.ref)
      || (req && req.query && req.query.ref);
    const s = String(raw == null ? '' : raw).trim();
    if (!/^\d{1,10}$/.test(s)) return null;
    const n = parseInt(s, 10);
    return n > 0 ? n : null;
  } catch (e) { return null; }
}

async function applyReferral(req, newUserId) {
  try {
    const rid = parseRefId(req);
    if (!rid || Number(rid) === Number(newUserId)) return null;
    const rep = await db.get('SELECT id FROM users WHERE id = ?', [rid]);
    if (!rep) return null;
    await db.run('UPDATE users SET referred_by = ? WHERE id = ?', [rep.id, newUserId]);
    console.log('  referral: user #' + newUserId + ' <- #' + rep.id);
    return rep.id;
  } catch (e) {
    console.error('referral error:', e.message);
    return null;
  }
}

module.exports = { applyReferral, parseRefId };
