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
 * Like resolveBranchScope, but lets a cross-branch role explicitly request
 * a true org-wide, all-branches view via `?branchId=all` — resolveBranchScope
 * itself always falls back to the caller's OWN home branch when no branchId
 * is given (a deliberate default so "no query param" means "my branch" for
 * every role, not an accident), which left owner/system_admin with no way
 * to ask for the consolidated view every list/analytics function already
 * supports at the service layer (`branchId: null`/undefined). Only
 * recognizes 'all' for CROSS_BRANCH_ROLES; every other caller (and every
 * other branchId value) defers to the exact same resolveBranchScope
 * behavior as before — see Decisions_Log.md. First added for the
 * analytics routes the dashboard needs a consolidated view from; also used
 * by the agents routes for the same reason (a supervisor's own roster/
 * reconciliation list otherwise silently narrowed to their home branch).
 */
function resolveConsolidatedBranchScope(req) {
  if (req.query.branchId === 'all' && CROSS_BRANCH_ROLES.has(req.user.roleName)) return null;
  return resolveBranchScope(req);
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

module.exports = { requirePermission, resolveBranchScope, resolveConsolidatedBranchScope, canAccessBranch, CROSS_BRANCH_ROLES };
