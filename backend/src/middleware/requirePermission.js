'use strict';

/**
 * Server-side permission enforcement. Every RBAC-gated route uses this —
 * permission checks must never rely on the frontend hiding a button.
 */
function requirePermission(permissionCode) {
  return function requirePermissionMiddleware(req, res, next) {
    if (!req.user) {
      return res.status(401).json({ error: 'authentication required' });
    }
    if (!req.user.permissions.has(permissionCode)) {
      return res.status(403).json({ error: `missing required permission: ${permissionCode}` });
    }
    return next();
  };
}

/**
 * Resolves the branch id a request is allowed to scope to. Owner and
 * system_admin roles may view/act across any branch (via an explicit
 * ?branchId= query param, defaulting to their own home branch); every
 * other role is pinned to their home branch regardless of what's in the
 * query string. See Decisions_Log.md "Branch Scoping Convention".
 */
const CROSS_BRANCH_ROLES = new Set(['owner', 'system_admin']);

function resolveBranchScope(req) {
  const requested = req.query.branchId ? Number(req.query.branchId) : null;
  if (requested && CROSS_BRANCH_ROLES.has(req.user.roleName)) {
    return requested;
  }
  return req.user.homeBranchId;
}

module.exports = { requirePermission, resolveBranchScope, CROSS_BRANCH_ROLES };
