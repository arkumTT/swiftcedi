'use strict';

const {
  addMonthsToDateString,
  generateLoanSchedule,
  allocateRepayment,
  computeOutstandingPrincipalPesewas,
  bucketArrearsDays,
  computeFeesPesewas,
  computeOverdraftInterestPesewas,
  computeFloatingEffectiveRateBps,
  evaluateConcessionBounds,
} = require('../../src/modules/loan/loanMath');

describe('addMonthsToDateString (pure)', () => {
  test('adds a simple month', () => {
    expect(addMonthsToDateString('2026-01-15', 1)).toBe('2026-02-15');
  });

  test('clamps month-end overflow instead of rolling into the next month', () => {
    expect(addMonthsToDateString('2026-01-31', 1)).toBe('2026-02-28'); // 2026 is not a leap year
    expect(addMonthsToDateString('2024-01-31', 1)).toBe('2024-02-29'); // 2024 is a leap year
  });

  test('crosses a year boundary', () => {
    expect(addMonthsToDateString('2026-12-01', 1)).toBe('2027-01-01');
  });
});

describe('generateLoanSchedule — flat method (pure)', () => {
  test('splits principal and interest evenly, remainder on the last installment', () => {
    const rows = generateLoanSchedule({
      principalPesewas: 100000,
      termMonths: 3,
      annualInterestRateBps: 2400, // 24% p.a.
      interestMethod: 'flat',
      startDate: '2026-01-01',
    });
    expect(rows).toHaveLength(3);
    expect(rows.reduce((s, r) => s + r.principalDuePesewas, 0)).toBe(100000);
    // total interest = 100000 * 0.24 * (3/12) = 6000
    expect(rows.reduce((s, r) => s + r.interestDuePesewas, 0)).toBe(6000);
  });

  test('never drifts on a principal that does not divide evenly by term', () => {
    const rows = generateLoanSchedule({
      principalPesewas: 100001,
      termMonths: 7,
      annualInterestRateBps: 1750,
      interestMethod: 'flat',
      startDate: '2026-01-01',
    });
    expect(rows.reduce((s, r) => s + r.principalDuePesewas, 0)).toBe(100001);
  });

  test('handles a zero interest rate', () => {
    const rows = generateLoanSchedule({
      principalPesewas: 90000,
      termMonths: 3,
      annualInterestRateBps: 0,
      interestMethod: 'flat',
      startDate: '2026-01-01',
    });
    expect(rows.every((r) => r.interestDuePesewas === 0)).toBe(true);
    expect(rows.reduce((s, r) => s + r.principalDuePesewas, 0)).toBe(90000);
  });
});

describe('generateLoanSchedule — reducing balance method (pure)', () => {
  test('sum of principalDue always equals the original principal exactly (anti-drift guarantee)', () => {
    const cases = [
      { principalPesewas: 100000, termMonths: 12, annualInterestRateBps: 2400 },
      { principalPesewas: 333333, termMonths: 7, annualInterestRateBps: 1899 },
      { principalPesewas: 1, termMonths: 1, annualInterestRateBps: 5000 },
      { principalPesewas: 987654321, termMonths: 24, annualInterestRateBps: 3650 },
      { principalPesewas: 500000, termMonths: 6, annualInterestRateBps: 0 },
    ];
    for (const c of cases) {
      const rows = generateLoanSchedule({ ...c, interestMethod: 'reducing_balance', startDate: '2026-01-01' });
      const totalPrincipal = rows.reduce((s, r) => s + r.principalDuePesewas, 0);
      expect(totalPrincipal).toBe(c.principalPesewas);
    }
  });

  test('interest declines installment over installment as the balance amortizes', () => {
    const rows = generateLoanSchedule({
      principalPesewas: 1000000,
      termMonths: 12,
      annualInterestRateBps: 2400,
      interestMethod: 'reducing_balance',
      startDate: '2026-01-01',
    });
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].interestDuePesewas).toBeLessThanOrEqual(rows[i - 1].interestDuePesewas);
    }
  });

  test('a single-installment loan pays off exactly principal + one period of interest', () => {
    const rows = generateLoanSchedule({
      principalPesewas: 100000,
      termMonths: 1,
      annualInterestRateBps: 1200,
      interestMethod: 'reducing_balance',
      startDate: '2026-01-01',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].principalDuePesewas).toBe(100000);
    expect(rows[0].interestDuePesewas).toBe(Math.round(100000 * (1200 / 12 / 10000)));
  });

  test('due dates step monthly from the start date', () => {
    const rows = generateLoanSchedule({
      principalPesewas: 300000,
      termMonths: 3,
      annualInterestRateBps: 1800,
      interestMethod: 'reducing_balance',
      startDate: '2026-01-31',
    });
    expect(rows.map((r) => r.dueDate)).toEqual(['2026-02-28', '2026-03-31', '2026-04-30']);
  });
});

describe('generateLoanSchedule validation (pure)', () => {
  test('rejects a non-positive principal', () => {
    expect(() =>
      generateLoanSchedule({ principalPesewas: 0, termMonths: 3, annualInterestRateBps: 100, interestMethod: 'flat', startDate: '2026-01-01' })
    ).toThrow();
  });

  test('rejects a non-positive term', () => {
    expect(() =>
      generateLoanSchedule({ principalPesewas: 1000, termMonths: 0, annualInterestRateBps: 100, interestMethod: 'flat', startDate: '2026-01-01' })
    ).toThrow();
  });

  test('rejects an unknown interest method', () => {
    expect(() =>
      generateLoanSchedule({ principalPesewas: 1000, termMonths: 3, annualInterestRateBps: 100, interestMethod: 'bogus', startDate: '2026-01-01' })
    ).toThrow(/interestMethod/);
  });
});

function makeRow(overrides) {
  return {
    id: 1,
    principalDuePesewas: 0,
    principalPaidPesewas: 0,
    interestDuePesewas: 0,
    interestPaidPesewas: 0,
    feesDuePesewas: 0,
    feesPaidPesewas: 0,
    ...overrides,
  };
}

describe('allocateRepayment (pure)', () => {
  test('a single installment: fees, then interest, then principal', () => {
    const row = makeRow({ id: 1, feesDuePesewas: 100, interestDuePesewas: 200, principalDuePesewas: 1000 });
    const { allocations, unallocatedPesewas } = allocateRepayment([row], 1300);
    expect(allocations).toEqual([{ scheduleId: 1, feesPaidPesewas: 100, interestPaidPesewas: 200, principalPaidPesewas: 1000 }]);
    expect(unallocatedPesewas).toBe(0);
  });

  test('a partial payment fills fees and interest before touching principal', () => {
    const row = makeRow({ id: 1, feesDuePesewas: 100, interestDuePesewas: 200, principalDuePesewas: 1000 });
    const { allocations } = allocateRepayment([row], 250);
    expect(allocations).toEqual([{ scheduleId: 1, feesPaidPesewas: 100, interestPaidPesewas: 150, principalPaidPesewas: 0 }]);
  });

  test('spills over to the next installment once the current one is fully covered', () => {
    const rows = [
      makeRow({ id: 1, interestDuePesewas: 200, principalDuePesewas: 1000 }),
      makeRow({ id: 2, interestDuePesewas: 180, principalDuePesewas: 1000 }),
    ];
    const { allocations, unallocatedPesewas } = allocateRepayment(rows, 1500);
    expect(allocations).toEqual([
      { scheduleId: 1, feesPaidPesewas: 0, interestPaidPesewas: 200, principalPaidPesewas: 1000 },
      { scheduleId: 2, feesPaidPesewas: 0, interestPaidPesewas: 180, principalPaidPesewas: 120 },
    ]);
    expect(unallocatedPesewas).toBe(0);
  });

  test('skips an already fully-paid installment', () => {
    const rows = [
      makeRow({ id: 1, interestDuePesewas: 200, interestPaidPesewas: 200, principalDuePesewas: 1000, principalPaidPesewas: 1000 }),
      makeRow({ id: 2, interestDuePesewas: 200, principalDuePesewas: 1000 }),
    ];
    const { allocations } = allocateRepayment(rows, 1200);
    expect(allocations).toEqual([{ scheduleId: 2, feesPaidPesewas: 0, interestPaidPesewas: 200, principalPaidPesewas: 1000 }]);
  });

  test('a partial payment against an already-partially-paid installment only covers what remains', () => {
    const row = makeRow({ id: 1, interestDuePesewas: 200, interestPaidPesewas: 50, principalDuePesewas: 1000 });
    const { allocations } = allocateRepayment([row], 150);
    expect(allocations).toEqual([{ scheduleId: 1, feesPaidPesewas: 0, interestPaidPesewas: 150, principalPaidPesewas: 0 }]);
  });

  test('returns the unallocated remainder when payment exceeds total outstanding', () => {
    const row = makeRow({ id: 1, interestDuePesewas: 100, principalDuePesewas: 500 });
    const { unallocatedPesewas } = allocateRepayment([row], 1000);
    expect(unallocatedPesewas).toBe(400);
  });

  test('rejects a non-positive amount', () => {
    expect(() => allocateRepayment([makeRow({})], 0)).toThrow();
    expect(() => allocateRepayment([makeRow({})], -5)).toThrow();
  });
});

describe('computeOutstandingPrincipalPesewas (pure)', () => {
  test('sums remaining principal across rows', () => {
    const rows = [
      makeRow({ principalDuePesewas: 1000, principalPaidPesewas: 400 }),
      makeRow({ principalDuePesewas: 1000, principalPaidPesewas: 1000 }),
      makeRow({ principalDuePesewas: 1000, principalPaidPesewas: 0 }),
    ];
    expect(computeOutstandingPrincipalPesewas(rows)).toBe(600 + 0 + 1000);
  });
});

describe('computeFeesPesewas (pure)', () => {
  test('sums flat fees', () => {
    expect(computeFeesPesewas([{ type: 'flat', amountPesewas: 5000 }, { type: 'flat', amountPesewas: 1500 }], 100000)).toBe(6500);
  });

  test('computes a percent-of-principal fee', () => {
    expect(computeFeesPesewas([{ type: 'percent_of_principal', rateBps: 250 }], 100000)).toBe(2500);
  });

  test('mixes flat and percentage fees', () => {
    expect(
      computeFeesPesewas([{ type: 'flat', amountPesewas: 1000 }, { type: 'percent_of_principal', rateBps: 100 }], 250000)
    ).toBe(1000 + 2500);
  });

  test('an empty or missing fee schedule is zero', () => {
    expect(computeFeesPesewas([], 100000)).toBe(0);
    expect(computeFeesPesewas(undefined, 100000)).toBe(0);
  });

  test('rejects an unknown fee type', () => {
    expect(() => computeFeesPesewas([{ type: 'mystery' }], 100000)).toThrow(/fee type/);
  });
});

describe('bucketArrearsDays (pure)', () => {
  const buckets = [30, 60, 90];

  test('not overdue returns null', () => {
    expect(bucketArrearsDays(0, buckets)).toBeNull();
    expect(bucketArrearsDays(-5, buckets)).toBeNull();
  });

  test('buckets match the spec example (1-30, 31-60, 61-90, 90+)', () => {
    expect(bucketArrearsDays(1, buckets)).toBe('1-30');
    expect(bucketArrearsDays(30, buckets)).toBe('1-30');
    expect(bucketArrearsDays(31, buckets)).toBe('31-60');
    expect(bucketArrearsDays(60, buckets)).toBe('31-60');
    expect(bucketArrearsDays(61, buckets)).toBe('61-90');
    expect(bucketArrearsDays(90, buckets)).toBe('61-90');
    expect(bucketArrearsDays(91, buckets)).toBe('90+');
    expect(bucketArrearsDays(400, buckets)).toBe('90+');
  });

  test('works with custom, unsorted boundaries', () => {
    expect(bucketArrearsDays(10, [90, 30, 60])).toBe('1-30');
  });
});

describe('computeOverdraftInterestPesewas (pure)', () => {
  test('a full year at a round rate matches the simple-interest formula exactly', () => {
    // 1,000,000 pesewas drawn at 24% p.a. for 365 days -> 240,000 pesewas.
    expect(
      computeOverdraftInterestPesewas({ drawnBalancePesewas: 1000000, annualInterestRateBps: 2400, days: 365 })
    ).toBe(240000);
  });

  test('prorates by days', () => {
    // 1,000,000 at 24% p.a. for 30 days -> round(1000000 * 0.24 * 30/365).
    const expected = Math.round((1000000 * 2400 * 30) / (365 * 10000));
    expect(computeOverdraftInterestPesewas({ drawnBalancePesewas: 1000000, annualInterestRateBps: 2400, days: 30 })).toBe(
      expected
    );
  });

  test('zero rate accrues nothing', () => {
    expect(computeOverdraftInterestPesewas({ drawnBalancePesewas: 1000000, annualInterestRateBps: 0, days: 30 })).toBe(0);
  });

  test('rejects a non-positive drawn balance', () => {
    expect(() => computeOverdraftInterestPesewas({ drawnBalancePesewas: 0, annualInterestRateBps: 2400, days: 30 })).toThrow(
      /drawnBalancePesewas/
    );
  });

  test('rejects a non-positive number of days', () => {
    expect(() =>
      computeOverdraftInterestPesewas({ drawnBalancePesewas: 1000000, annualInterestRateBps: 2400, days: 0 })
    ).toThrow(/days/);
  });
});

describe('computeFloatingEffectiveRateBps (pure)', () => {
  test('reference rate plus spread', () => {
    expect(computeFloatingEffectiveRateBps({ referenceRateBps: 2900, spreadBps: 500 })).toBe(3400);
  });

  test('zero spread just mirrors the reference rate', () => {
    expect(computeFloatingEffectiveRateBps({ referenceRateBps: 2900, spreadBps: 0 })).toBe(2900);
  });

  test('rejects a negative reference rate', () => {
    expect(() => computeFloatingEffectiveRateBps({ referenceRateBps: -1, spreadBps: 500 })).toThrow(/referenceRateBps/);
  });

  test('rejects a negative spread', () => {
    expect(() => computeFloatingEffectiveRateBps({ referenceRateBps: 2900, spreadBps: -1 })).toThrow(/spreadBps/);
  });
});

describe('evaluateConcessionBounds (pure)', () => {
  test('a fixed-product concession within the floor and within the grace threshold auto-applies', () => {
    const result = evaluateConcessionBounds({
      rateType: 'fixed',
      standardAnnualInterestRateBps: 2400,
      negotiatedAnnualInterestRateBps: 2350, // 50bps discount
      minRateFloorBps: 2000,
      concessionApprovalThresholdBps: 100,
    });
    expect(result).toEqual({ permitted: true, withinFloor: true, appliedFloorBps: 2000, deltaBps: 50, needsApproval: false });
  });

  test('a fixed-product concession beyond the grace threshold needs approval', () => {
    const result = evaluateConcessionBounds({
      rateType: 'fixed',
      standardAnnualInterestRateBps: 2400,
      negotiatedAnnualInterestRateBps: 2100, // 300bps discount
      minRateFloorBps: 2000,
      concessionApprovalThresholdBps: 100,
    });
    expect(result.permitted).toBe(true);
    expect(result.needsApproval).toBe(true);
    expect(result.deltaBps).toBe(300);
  });

  test('a fixed-product concession breaching the floor is not permitted, regardless of threshold', () => {
    const result = evaluateConcessionBounds({
      rateType: 'fixed',
      standardAnnualInterestRateBps: 2400,
      negotiatedAnnualInterestRateBps: 1900, // below the 2000bps floor
      minRateFloorBps: 2000,
      concessionApprovalThresholdBps: 1000,
    });
    expect(result.permitted).toBe(false);
    expect(result.withinFloor).toBe(false);
    expect(result.needsApproval).toBe(false);
  });

  test('a negotiated rate above standard is a markup, never permitted', () => {
    const result = evaluateConcessionBounds({
      rateType: 'fixed',
      standardAnnualInterestRateBps: 2400,
      negotiatedAnnualInterestRateBps: 2500,
      minRateFloorBps: 2000,
      concessionApprovalThresholdBps: 100,
    });
    expect(result.permitted).toBe(false);
  });

  test('no floor configured on the product means concessions are not permitted at all', () => {
    const result = evaluateConcessionBounds({
      rateType: 'fixed',
      standardAnnualInterestRateBps: 2400,
      negotiatedAnnualInterestRateBps: 2350,
      minRateFloorBps: null,
      concessionApprovalThresholdBps: 100,
    });
    expect(result.permitted).toBe(false);
    expect(result.appliedFloorBps).toBeNull();
  });

  test('a floating-product concession is evaluated on the spread, not the blended rate', () => {
    const result = evaluateConcessionBounds({
      rateType: 'floating',
      standardAnnualInterestRateBps: 3400, // blended rate, irrelevant to the bound check
      negotiatedAnnualInterestRateBps: 3300,
      standardSpreadBps: 500,
      negotiatedSpreadBps: 400,
      minSpreadFloorBps: 300,
      concessionApprovalThresholdBps: 50,
    });
    expect(result.permitted).toBe(true);
    expect(result.appliedFloorBps).toBe(300);
    expect(result.deltaBps).toBe(100);
    expect(result.needsApproval).toBe(true);
  });

  test('a term or fee change forces approval even for a zero-bps rate concession', () => {
    const result = evaluateConcessionBounds({
      rateType: 'fixed',
      standardAnnualInterestRateBps: 2400,
      negotiatedAnnualInterestRateBps: 2400,
      minRateFloorBps: 2000,
      concessionApprovalThresholdBps: 100,
      termChanged: true,
    });
    expect(result.permitted).toBe(true);
    expect(result.deltaBps).toBe(0);
    expect(result.needsApproval).toBe(true);
  });

  test('rejects an unknown rateType', () => {
    expect(() =>
      evaluateConcessionBounds({
        rateType: 'weird',
        standardAnnualInterestRateBps: 2400,
        negotiatedAnnualInterestRateBps: 2400,
        concessionApprovalThresholdBps: 0,
      })
    ).toThrow(/rateType/);
  });
});
