'use strict';

const {
  resolveChargesConfig,
  resolveWithdrawalThresholdPesewas,
  withdrawalNeedsApproval,
  assessWithdrawal,
  computeMinBalanceChargePesewas,
  computeMaintenanceFeePesewas,
  computeCommissionPesewas,
  resolveCycleOutcome,
  nextRunDate,
  addDaysToDateString,
} = require('../../src/modules/savings/savingsMath');

const product = {
  min_balance_pesewas: 1000,
  maintenance_fee_pesewas: 500,
  withdrawal_fee_pesewas: 200,
  min_balance_charge_pesewas: 300,
  withdrawal_approval_threshold_pesewas: 100000,
};

describe('resolveChargesConfig (pure)', () => {
  test('uses the product config when the account has no override', () => {
    expect(resolveChargesConfig(product, null)).toEqual({
      minBalancePesewas: 1000,
      maintenanceFeePesewas: 500,
      withdrawalFeePesewas: 200,
      minBalanceChargePesewas: 300,
      withdrawalApprovalThresholdPesewas: 100000,
    });
  });

  test('an account override wins field by field, leaving the rest from the product', () => {
    const merged = resolveChargesConfig(product, { withdrawalFeePesewas: 0, minBalancePesewas: 5000 });
    expect(merged.withdrawalFeePesewas).toBe(0);
    expect(merged.minBalancePesewas).toBe(5000);
    expect(merged.maintenanceFeePesewas).toBe(500); // untouched
  });

  test('a null/undefined field in the override does not clobber the product value', () => {
    const merged = resolveChargesConfig(product, { withdrawalFeePesewas: null, maintenanceFeePesewas: undefined });
    expect(merged.withdrawalFeePesewas).toBe(200);
    expect(merged.maintenanceFeePesewas).toBe(500);
  });
});

describe('resolveWithdrawalThresholdPesewas (pure)', () => {
  test('falls back to the product/account config when no approval_thresholds row exists', () => {
    expect(resolveWithdrawalThresholdPesewas(null, resolveChargesConfig(product, null))).toBe(100000);
  });

  test('a Module 11 approval_thresholds row overrides the product config', () => {
    const row = { amount_threshold_pesewas: 25000 };
    expect(resolveWithdrawalThresholdPesewas(row, resolveChargesConfig(product, null))).toBe(25000);
  });

  test('a threshold of 0 from the thresholds table is honoured, not treated as absent', () => {
    expect(resolveWithdrawalThresholdPesewas({ amount_threshold_pesewas: 0 }, resolveChargesConfig(product, null))).toBe(0);
  });
});

describe('withdrawalNeedsApproval (pure)', () => {
  test('at or above the threshold needs approval; below does not', () => {
    expect(withdrawalNeedsApproval(99999, 100000)).toBe(false);
    expect(withdrawalNeedsApproval(100000, 100000)).toBe(true);
    expect(withdrawalNeedsApproval(100001, 100000)).toBe(true);
  });

  test('a zero threshold means every withdrawal needs approval', () => {
    expect(withdrawalNeedsApproval(1, 0)).toBe(true);
  });
});

describe('assessWithdrawal (pure)', () => {
  const charges = resolveChargesConfig(product, null);

  test('permits a withdrawal that leaves the minimum balance intact', () => {
    const result = assessWithdrawal({ balancePesewas: 50000, amountPesewas: 10000, chargesConfig: charges });
    expect(result.ok).toBe(true);
    expect(result.feePesewas).toBe(200);
    expect(result.totalDebitPesewas).toBe(10200);
    expect(result.balanceAfterPesewas).toBe(39800);
  });

  test('rejects a withdrawal that would breach the minimum balance once the fee is counted', () => {
    // 50000 - 48900 - 200 fee = 900, below the 1000 minimum.
    const result = assessWithdrawal({ balancePesewas: 50000, amountPesewas: 48900, chargesConfig: charges });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/minimum balance/);
  });

  test('the fee itself can be what tips it over', () => {
    const exact = assessWithdrawal({ balancePesewas: 50000, amountPesewas: 48800, chargesConfig: charges });
    expect(exact.ok).toBe(true);
    expect(exact.balanceAfterPesewas).toBe(1000);
    const oneMore = assessWithdrawal({ balancePesewas: 50000, amountPesewas: 48801, chargesConfig: charges });
    expect(oneMore.ok).toBe(false);
  });

  test('with no minimum balance, the wording is about available balance', () => {
    const noMin = resolveChargesConfig({ ...product, min_balance_pesewas: 0 }, null);
    const result = assessWithdrawal({ balancePesewas: 1000, amountPesewas: 900, chargesConfig: noMin });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/available balance/);
  });

  test('rejects a non-positive amount', () => {
    expect(assessWithdrawal({ balancePesewas: 50000, amountPesewas: 0, chargesConfig: charges }).ok).toBe(false);
    expect(assessWithdrawal({ balancePesewas: 50000, amountPesewas: -100, chargesConfig: charges }).ok).toBe(false);
  });

  test('an overdraft-enabled product bypasses the balance check', () => {
    const result = assessWithdrawal({
      balancePesewas: 100,
      amountPesewas: 50000,
      chargesConfig: charges,
      allowsOverdraft: true,
    });
    expect(result.ok).toBe(true);
    expect(result.balanceAfterPesewas).toBe(100 - 50000 - 200);
  });
});

describe('computeMinBalanceChargePesewas (pure)', () => {
  const charges = resolveChargesConfig(product, null);

  test('no charge while the balance is at or above the minimum', () => {
    expect(computeMinBalanceChargePesewas(1000, charges)).toBe(0);
    expect(computeMinBalanceChargePesewas(5000, charges)).toBe(0);
  });

  test('charges when the balance has fallen below the minimum', () => {
    expect(computeMinBalanceChargePesewas(999, charges)).toBe(300);
  });

  test('never charges more than the remaining balance', () => {
    expect(computeMinBalanceChargePesewas(100, charges)).toBe(100);
    expect(computeMinBalanceChargePesewas(0, charges)).toBe(0);
  });

  test('no charge configured means no charge', () => {
    const noCharge = resolveChargesConfig({ ...product, min_balance_charge_pesewas: 0 }, null);
    expect(computeMinBalanceChargePesewas(0, noCharge)).toBe(0);
  });
});

describe('computeMaintenanceFeePesewas (pure)', () => {
  const charges = resolveChargesConfig(product, null);

  test('charges the configured fee', () => {
    expect(computeMaintenanceFeePesewas(50000, charges)).toBe(500);
  });

  test('caps at the available balance rather than overdrawing', () => {
    expect(computeMaintenanceFeePesewas(200, charges)).toBe(200);
    expect(computeMaintenanceFeePesewas(0, charges)).toBe(0);
  });
});

describe('computeCommissionPesewas (pure)', () => {
  test('computes basis-point commission and rounds to whole pesewas', () => {
    expect(computeCommissionPesewas(10000, 500)).toBe(500); // 5%
    expect(computeCommissionPesewas(3333, 500)).toBe(167); // 166.65 -> 167
  });

  test('zero rate or zero amount yields no commission', () => {
    expect(computeCommissionPesewas(10000, 0)).toBe(0);
    expect(computeCommissionPesewas(0, 500)).toBe(0);
  });
});

describe('resolveCycleOutcome (pure)', () => {
  test('reaching the target completes the cycle', () => {
    expect(resolveCycleOutcome(100000, 100000)).toBe('completed');
    expect(resolveCycleOutcome(100001, 100000)).toBe('completed');
  });

  test('falling short leaves it uncompleted', () => {
    expect(resolveCycleOutcome(99999, 100000)).toBe('uncompleted');
    expect(resolveCycleOutcome(0, 100000)).toBe('uncompleted');
  });
});

describe('nextRunDate (pure)', () => {
  test('daily and weekly step by days', () => {
    expect(nextRunDate('2026-01-01', 'daily')).toBe('2026-01-02');
    expect(nextRunDate('2026-01-01', 'weekly')).toBe('2026-01-08');
  });

  test('monthly clamps month-end the same way loan schedules do', () => {
    expect(nextRunDate('2026-01-15', 'monthly')).toBe('2026-02-15');
    expect(nextRunDate('2026-01-31', 'monthly')).toBe('2026-02-28');
    expect(nextRunDate('2024-01-31', 'monthly')).toBe('2024-02-29');
  });

  test('crosses a year boundary', () => {
    expect(nextRunDate('2026-12-15', 'monthly')).toBe('2027-01-15');
  });

  test('rejects an unknown frequency', () => {
    expect(() => nextRunDate('2026-01-01', 'fortnightly')).toThrow(/frequency/);
  });
});

describe('addDaysToDateString (pure)', () => {
  test('adds days across a month boundary', () => {
    expect(addDaysToDateString('2026-01-30', 3)).toBe('2026-02-02');
  });
});
