'use strict';

const { getSession } = require('./sessionStore');

/**
 * Loads the authenticated user (with role name and permission codes) onto
 * req.user from the `Authorization: Bearer <token>` header. Every route
 * that touches RBAC, audit, approvals, or GL requires this.
 */
function requireAuth(pool) {
  return async function requireAuthMiddleware(req, res, next) {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      return res.status(401).json({ error: 'missing or malformed Authorization header' });
    }

    const session = getSession(token);
    if (!session) {
      return res.status(401).json({ error: 'invalid or expired session' });
    }

    const { rows } = await pool.query(
      `SELECT u.id, u.full_name, u.email, u.status, u.home_branch_id, u.role_id, r.name AS role_name,
              COALESCE(array_agg(p.code) FILTER (WHERE p.code IS NOT NULL), '{}') AS permissions
       FROM users u
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
       LEFT JOIN permissions p ON p.id = rp.permission_id
       WHERE u.id = $1
       GROUP BY u.id, r.name`,
      [session.userId]
    );

    const user = rows[0];
    if (!user || user.status !== 'active') {
      return res.status(401).json({ error: 'user not found or not active' });
    }

    // Module 1: active (non-revoked, within date range) cross-branch access
    // grants also let a user scope requests to a branch that isn't their
    // home branch — see requirePermission.js's resolveBranchScope.
    const { rows: grantRows } = await pool.query(
      `SELECT branch_id FROM cross_branch_access_grants
       WHERE user_id = $1 AND revoked_at IS NULL AND start_date <= current_date AND end_date >= current_date`,
      [user.id]
    );

    req.user = {
      id: user.id,
      fullName: user.full_name,
      email: user.email,
      homeBranchId: user.home_branch_id,
      roleId: user.role_id,
      roleName: user.role_name,
      permissions: new Set(user.permissions),
      crossBranchAccessibleBranchIds: new Set(grantRows.map((r) => r.branch_id)),
    };
    return next();
  };
}

module.exports = { requireAuth };
