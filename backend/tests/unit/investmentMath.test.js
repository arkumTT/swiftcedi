'use strict';

const {
  addMonthsToDateString,
  computeMaturityDate,
  daysBetween,
  isEarlyRedemption,
  computeAccrualPesewas,
  computeRedemptionPesewas,
} = require('../../src/modules/investment/investmentMath');

describe('addMonthsToDateString / computeMaturityDate (pure)', () => {
  test('adds a simple month', () => {
    expect(addMonthsToDateString('2026-01-15', 1)).toBe('2026-02-15');
  });

  test('clamps month-end overflow instead of rolling into the next month', () => {
    expect(addMonthsToDateString('2026-01-31', 1)).toBe('2026-02-28'); // 2026 is not a leap year
    expect(addMonthsToDateString('2024-01-31', 1)).toBe('2024-02-29'); // 2024 is a leap year
  });

  test('computeMaturityDate adds the product tenor', () => {
    expect(computeMaturityDate('2026-01-01', 12)).toBe('2027-01-01');
    expect(computeMaturityDate('2026-01-31', 1)).toBe('2026-02-28');
  });

  test('computeMaturityDate rejects a non-positive tenor', () => {
    expect(() => computeMaturityDate('2026-01-01', 0)).toThrow(/tenorMonths/);
  });
});

describe('daysBetween (pure)', () => {
  test('counts whole days', () => {
    expect(daysBetween('2026-01-01', '2026-01-31')).toBe(30);
    expect(daysBetween('2026-01-01', '2026-01-01')).toBe(0);
  });

  test('rejects a reversed range', () => {
    expect(() => daysBetween('2026-02-01', '2026-01-01')).toThrow(/must not be before/);
  });
});

describe('isEarlyRedemption (pure)', () => {
  test('before maturity is early', () => {
    expect(isEarlyRedemption('2026-06-01', '2027-01-01')).toBe(true);
  });

  test('on or after maturity is not early', () => {
    expect(isEarlyRedemption('2027-01-01', '2027-01-01')).toBe(false);
    expect(isEarlyRedemption('2027-02-01', '2027-01-01')).toBe(false);
  });
});

describe('computeAccrualPesewas (pure)', () => {
  test('a full year at a round rate matches the simple-interest formula exactly', () => {
    // 1,000,000 pesewas at 18% p.a. for 365 days -> 180,000 pesewas.
    expect(computeAccrualPesewas({ principalPesewas: 1000000, annualInterestRateBps: 1800, days: 365 })).toBe(180000);
  });

  test('prorates by days', () => {
    const expected = Math.round((1000000 * 1800 * 30) / (365 * 10000));
    expect(computeAccrualPesewas({ principalPesewas: 1000000, annualInterestRateBps: 1800, days: 30 })).toBe(expected);
  });

  test('does not compound — always computed on the same principal, not a running balance', () => {
    const first = computeAccrualPesewas({ principalPesewas: 1000000, annualInterestRateBps: 1800, days: 30 });
    const second = computeAccrualPesewas({ principalPesewas: 1000000, annualInterestRateBps: 1800, days: 30 });
    expect(first).toBe(second);
  });

  test('zero rate accrues nothing', () => {
    expect(computeAccrualPesewas({ principalPesewas: 1000000, annualInterestRateBps: 0, days: 30 })).toBe(0);
  });

  test('rejects a non-positive principal, negative rate, or non-positive days', () => {
    expect(() => computeAccrualPesewas({ principalPesewas: 0, annualInterestRateBps: 1800, days: 30 })).toThrow(
      /principalPesewas/
    );
    expect(() => computeAccrualPesewas({ principalPesewas: 1000, annualInterestRateBps: -1, days: 30 })).toThrow(
      /annualInterestRateBps/
    );
    expect(() => computeAccrualPesewas({ principalPesewas: 1000, annualInterestRateBps: 1800, days: 0 })).toThrow(
      /days/
    );
  });
});

describe('computeRedemptionPesewas (pure)', () => {
  test('at-maturity redemption pays out principal + full accrued interest, no penalty', () => {
    const result = computeRedemptionPesewas({
      principalPesewas: 1000000,
      accruedInterestPesewas: 180000,
      isEarly: false,
      penaltyRateBps: 5000, // 50% — irrelevant since not early
    });
    expect(result).toEqual({ penaltyPesewas: 0, interestPayablePesewas: 180000, totalPayoutPesewas: 1180000 });
  });

  test('early redemption forfeits the configured fraction of accrued interest, never principal', () => {
    const result = computeRedemptionPesewas({
      principalPesewas: 1000000,
      accruedInterestPesewas: 100000,
      isEarly: true,
      penaltyRateBps: 5000, // 50%
    });
    expect(result).toEqual({ penaltyPesewas: 50000, interestPayablePesewas: 50000, totalPayoutPesewas: 1050000 });
    // Principal is always returned in full.
    expect(result.totalPayoutPesewas - result.interestPayablePesewas).toBe(1000000);
  });

  test('a 100% early penalty forfeits all accrued interest but still returns full principal', () => {
    const result = computeRedemptionPesewas({
      principalPesewas: 500000,
      accruedInterestPesewas: 40000,
      isEarly: true,
      penaltyRateBps: 10000,
    });
    expect(result).toEqual({ penaltyPesewas: 40000, interestPayablePesewas: 0, totalPayoutPesewas: 500000 });
  });

  test('a zero penalty rate on an early redemption returns everything accrued, same as at maturity', () => {
    const result = computeRedemptionPesewas({
      principalPesewas: 500000,
      accruedInterestPesewas: 40000,
      isEarly: true,
      penaltyRateBps: 0,
    });
    expect(result).toEqual({ penaltyPesewas: 0, interestPayablePesewas: 40000, totalPayoutPesewas: 540000 });
  });

  test('rejects a non-positive principal or negative accrued interest', () => {
    expect(() =>
      computeRedemptionPesewas({ principalPesewas: 0, accruedInterestPesewas: 0, isEarly: false, penaltyRateBps: 0 })
    ).toThrow(/principalPesewas/);
    expect(() =>
      computeRedemptionPesewas({ principalPesewas: 1000, accruedInterestPesewas: -1, isEarly: false, penaltyRateBps: 0 })
    ).toThrow(/accruedInterestPesewas/);
  });
});
