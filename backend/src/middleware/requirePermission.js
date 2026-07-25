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
 * ?branchId= query param, defaulting to their own home branch); any other
 * role may only do so for a branch they hold an active Module 1
 * cross-branch access grant for (req.user.crossBranchAccessibleBranchIds,
 * populated by requireAuth). Otherwise every role is pinned to their home
 * branch regardless of what's in the query string. See Decisions_Log.md
 * "Branch Scoping Convention".
 */
const CROSS_BRANCH_ROLES = new Set(['owner', 'system_admin']);

function resolveBranchScope(req) {
  const requested = req.query.branchId ? Number(req.query.branchId) : null;
  if (!requested) return req.user.homeBranchId;
  if (CROSS_BRANCH_ROLES.has(req.user.roleName)) return requested;
  if (req.user.crossBranchAccessibleBranchIds && req.user.crossBranchAccessibleBranchIds.has(requested)) {
    return requested;
  }
  return req.user.homeBranchId;
}

/**
 * For endpoints scoped by a path param (e.g. GET /branches/:id/performance)
 * rather than a ?branchId= query param — same access rule as
 * resolveBranchScope, just checked against an arbitrary branchId instead of
 * derived from the query string.
 */
function canAccessBranch(req, branchId) {
  const id = Number(branchId);
  if (CROSS_BRANCH_ROLES.has(req.user.roleName)) return true;
  if (Number(req.user.homeBranchId) === id) return true;
  return Boolean(req.user.crossBranchAccessibleBranchIds && req.user.crossBranchAccessibleBranchIds.has(id));
}

module.exports = { requirePermission, resolveBranchScope, canAccessBranch, CROSS_BRANCH_ROLES };
