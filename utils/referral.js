/**
 * 推广归因 + 阶段1奖励（老带新）
 *  - 归因：新用户 referred_by = 推广人
 *  - 奖励：双向赠送 VIP 天数（推荐人 +3 / 新人 +3）
 *  - 佣金：被推荐人付费时生成佣金记录（见 routes/users.js）
 */
const db = require('../config/database');

const REWARD_DAYS = 3;        // 邀请注册：双方各得 VIP 天数
const COMMISSION_RATE = 0.6;  // 转化佣金比例（60%）

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

/** 给用户加 N 天 VIP（保留当前未到期的剩余时长；admin 跳过） */
async function grantVipDays(userId, days) {
  try {
    const u = await db.get('SELECT id, role, plan, expires_at FROM users WHERE id = ?', [userId]);
    if (!u || u.role === 'admin') return null;
    const now = Date.now();
    const cur = (u.plan === 'vip' && u.expires_at) ? new Date(u.expires_at).getTime() : 0;
    const base = (cur && cur > now) ? cur : now;
    const newExp = new Date(base + days * 86400000).toISOString().replace('T', ' ').slice(0, 19);
    await db.run("UPDATE users SET plan = 'vip', expires_at = ? WHERE id = ?", [newExp, userId]);
    return newExp;
  } catch (e) {
    console.error('grantVipDays error:', e.message);
    return null;
  }
}

async function applyReferral(req, newUserId) {
  try {
    const rid = parseRefId(req);
    if (!rid || Number(rid) === Number(newUserId)) return null;
    const rep = await db.get('SELECT id, role FROM users WHERE id = ?', [rid]);
    if (!rep) return null;

    // 1) 写入归因（仅首次）
    await db.run('UPDATE users SET referred_by = ? WHERE id = ? AND (referred_by IS NULL OR referred_by = 0)',
                 [rep.id, newUserId]);
    const chk = await db.get('SELECT referred_by FROM users WHERE id = ?', [newUserId]);
    if (!chk || Number(chk.referred_by) !== Number(rep.id)) return null;   // 已被他人归因，不重复奖励

    // 2) 双向赠送 VIP 天数
    const expRef = await grantVipDays(rep.id, REWARD_DAYS);
    const expNew = await grantVipDays(newUserId, REWARD_DAYS);

    console.log('  referral: user #' + newUserId + ' <- #' + rep.id + ' (+' + REWARD_DAYS + 'd both)');
    return rep.id;
  } catch (e) {
    console.error('referral error:', e.message);
    return null;
  }
}

/** 被推荐人付费/续费 → 生成佣金记录（60%，每次付费都计） */
async function recordCommission(refereeId, plan, amount) {
  try {
    const u = await db.get('SELECT referred_by FROM users WHERE id = ?', [refereeId]);
    if (!u || !u.referred_by) return null;
    // 每次付费都计佣（含续费）；仅过滤 2 分钟内的重复提交（防误触/重放）
    const existed = await db.get(
      "SELECT id FROM referral_commissions WHERE referee_id = ? AND status != 'cancelled' AND created_at > datetime('now', '-2 minutes')",
      [refereeId]);
    if (existed) return null;
    const commission = Math.round(Number(amount || 0) * COMMISSION_RATE * 100) / 100;
    if (commission <= 0) return null;
    await db.run(
      "INSERT INTO referral_commissions (referrer_id, referee_id, plan, order_amount, rate, commission, status) VALUES (?,?,?,?,?,?,'pending')",
      [u.referred_by, refereeId, plan || '', Number(amount || 0), COMMISSION_RATE, commission]);
    console.log('  commission: referrer #' + u.referred_by + ' +' + commission + ' (from #' + refereeId + ')');
    return commission;
  } catch (e) {
    console.error('recordCommission error:', e.message);
    return null;
  }
}

module.exports = { applyReferral, parseRefId, grantVipDays, recordCommission, REWARD_DAYS, COMMISSION_RATE };
