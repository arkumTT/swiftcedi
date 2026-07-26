// Mirrors backend/src/middleware/requirePermission.js's CROSS_BRANCH_ROLES
// exactly — owner/system_admin see consolidated, cross-branch data by
// default; every other role is pinned to their own home branch.
const CROSS_BRANCH_ROLES = new Set(['owner', 'system_admin']);

export function isCrossBranchRole(roleName: string): boolean {
  return CROSS_BRANCH_ROLES.has(roleName);
}
