'use strict';

const { resolveBranchScope, resolveConsolidatedBranchScope, canAccessBranch } = require('../../src/middleware/requirePermission');

function makeReq({ roleName, homeBranchId = 1, branchId, crossBranchAccessibleBranchIds = new Set() }) {
  return {
    query: branchId !== undefined ? { branchId } : {},
    user: { roleName, homeBranchId, crossBranchAccessibleBranchIds },
  };
}

describe('resolveBranchScope', () => {
  test('defaults to the caller\'s own home branch when no branchId is given, even for a cross-branch role', () => {
    expect(resolveBranchScope(makeReq({ roleName: 'owner', homeBranchId: 5 }))).toBe(5);
  });

  test('a cross-branch role may view an explicit other branch', () => {
    expect(resolveBranchScope(makeReq({ roleName: 'system_admin', homeBranchId: 1, branchId: '9' }))).toBe(9);
  });

  test('a non-cross-branch role without a matching grant is pinned to home branch regardless of the query param', () => {
    expect(resolveBranchScope(makeReq({ roleName: 'loan_officer', homeBranchId: 1, branchId: '9' }))).toBe(1);
  });

  test('a non-cross-branch role WITH an active cross-branch grant may view that specific branch', () => {
    const req = makeReq({ roleName: 'branch_manager', homeBranchId: 1, branchId: '9', crossBranchAccessibleBranchIds: new Set([9]) });
    expect(resolveBranchScope(req)).toBe(9);
  });
});

describe('resolveConsolidatedBranchScope', () => {
  test('?branchId=all resolves to null (consolidated) for a cross-branch role', () => {
    expect(resolveConsolidatedBranchScope(makeReq({ roleName: 'owner', branchId: 'all' }))).toBeNull();
    expect(resolveConsolidatedBranchScope(makeReq({ roleName: 'system_admin', branchId: 'all' }))).toBeNull();
  });

  test('?branchId=all for a non-cross-branch role falls back to their home branch, not an error', () => {
    expect(resolveConsolidatedBranchScope(makeReq({ roleName: 'loan_officer', homeBranchId: 3, branchId: 'all' }))).toBe(3);
  });

  test('an explicit numeric branchId behaves exactly like resolveBranchScope for every role', () => {
    expect(resolveConsolidatedBranchScope(makeReq({ roleName: 'owner', branchId: '7' }))).toBe(7);
    expect(resolveConsolidatedBranchScope(makeReq({ roleName: 'loan_officer', homeBranchId: 2, branchId: '7' }))).toBe(2);
  });

  test('no branchId at all still defaults to home branch, same as resolveBranchScope', () => {
    expect(resolveConsolidatedBranchScope(makeReq({ roleName: 'owner', homeBranchId: 4 }))).toBe(4);
  });
});

describe('canAccessBranch', () => {
  test('cross-branch roles can access any branch', () => {
    expect(canAccessBranch({ user: { roleName: 'owner', homeBranchId: 1, crossBranchAccessibleBranchIds: new Set() } }, 99)).toBe(true);
  });
  test('a role can always access its own home branch', () => {
    expect(canAccessBranch({ user: { roleName: 'cashier', homeBranchId: 5, crossBranchAccessibleBranchIds: new Set() } }, 5)).toBe(true);
  });
  test('a role without a grant cannot access another branch', () => {
    expect(canAccessBranch({ user: { roleName: 'cashier', homeBranchId: 5, crossBranchAccessibleBranchIds: new Set() } }, 6)).toBe(false);
  });
});
