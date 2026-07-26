'use strict';

const {
  validateBranchCode,
  isValidStatusTransition,
  isGrantActive,
  glSubAccountCode,
  BranchValidationError,
} = require('../../src/modules/branch/branchService');

describe('validateBranchCode (pure)', () => {
  test('accepts a valid code and uppercases it', () => {
    expect(validateBranchCode('nra-01')).toBe('NRA-01');
  });

  test('accepts the minimum length (2 chars)', () => {
    expect(validateBranchCode('HQ')).toBe('HQ');
  });

  test('rejects a code longer than 10 characters', () => {
    expect(() => validateBranchCode('THIS-IS-WAY-TOO-LONG')).toThrow(BranchValidationError);
  });

  test('rejects a single-character code', () => {
    expect(() => validateBranchCode('H')).toThrow(BranchValidationError);
  });

  test('rejects an empty or missing code', () => {
    expect(() => validateBranchCode('')).toThrow(BranchValidationError);
    expect(() => validateBranchCode(undefined)).toThrow(BranchValidationError);
  });

  test('rejects codes with disallowed characters', () => {
    expect(() => validateBranchCode('NRA_01')).toThrow(BranchValidationError);
    expect(() => validateBranchCode('NRA 01')).toThrow(BranchValidationError);
  });
});

describe('isValidStatusTransition (pure)', () => {
  test('active can move to suspended or under_review, but not directly to closed', () => {
    expect(isValidStatusTransition('active', 'suspended')).toBe(true);
    expect(isValidStatusTransition('active', 'under_review')).toBe(true);
    expect(isValidStatusTransition('active', 'closed')).toBe(false);
  });

  test('suspended and under_review can both reach closed', () => {
    expect(isValidStatusTransition('suspended', 'closed')).toBe(true);
    expect(isValidStatusTransition('under_review', 'closed')).toBe(true);
  });

  test('suspended and under_review can reactivate to active', () => {
    expect(isValidStatusTransition('suspended', 'active')).toBe(true);
    expect(isValidStatusTransition('under_review', 'active')).toBe(true);
  });

  test('closed is terminal', () => {
    expect(isValidStatusTransition('closed', 'active')).toBe(false);
    expect(isValidStatusTransition('closed', 'suspended')).toBe(false);
  });

  test('rejects an unknown status', () => {
    expect(isValidStatusTransition('active', 'deleted')).toBe(false);
    expect(isValidStatusTransition('bogus', 'active')).toBe(false);
  });
});

describe('isGrantActive (pure)', () => {
  const activeGrant = { start_date: '2026-01-01', end_date: '2026-12-31', revoked_at: null };

  test('active within the date range', () => {
    expect(isGrantActive(activeGrant, new Date('2026-06-15'))).toBe(true);
  });

  test('inactive before the start date', () => {
    expect(isGrantActive(activeGrant, new Date('2025-12-31'))).toBe(false);
  });

  test('inactive after the end date (auto-expiry)', () => {
    expect(isGrantActive(activeGrant, new Date('2027-01-01'))).toBe(false);
  });

  test('inactive once revoked, even mid-range', () => {
    const revoked = { ...activeGrant, revoked_at: '2026-03-01T00:00:00Z' };
    expect(isGrantActive(revoked, new Date('2026-06-15'))).toBe(false);
  });

  test('boundary dates are inclusive', () => {
    expect(isGrantActive(activeGrant, new Date('2026-01-01'))).toBe(true);
    expect(isGrantActive(activeGrant, new Date('2026-12-31'))).toBe(true);
  });
});

describe('glSubAccountCode (pure)', () => {
  test('composes control code and branch code with a dot', () => {
    expect(glSubAccountCode('1000', 'NRA-01')).toBe('1000.NRA-01');
  });
});
