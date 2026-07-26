'use strict';

/**
 * Pure investment math for Module 5 — no db, no side effects. Same split
 * as Module 3's loanMath.js and Module 4's savingsMath.js: the interest
 * accrual and early-withdrawal-penalty rules are exactly the business
 * logic CLAUDE.md wants unit-tested alongside the implementation.
 *
 * Deliberately does NOT import loanMath.js/savingsMath.js even though the
 * month-clamping and simple-interest formulas are identical — each
 * module's math file is self-contained and independently testable, the
 * same choice Module 4 made for its own date helpers (see
 * savingsMath.nextRunDate's comment).
 */

/** Adds `months` to a 'YYYY-MM-DD' date string, clamping to the target month's last day on overflow (e.g. Jan 31 + 1 month -> Feb 28/29, not Mar 3). */
function addMonthsToDateString(dateStr, months) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const originalDay = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  if (d.getUTCDate() !== originalDay) {
    d.setUTCDate(0);
  }
  return d.toISOString().slice(0, 10);
}

/** An investment's maturity date is its start date plus the product's tenor. */
function computeMaturityDate(startDate, tenorMonths) {
  if (!Number.isInteger(tenorMonths) || tenorMonths <= 0) {
    throw new Error('tenorMonths must be a positive integer');
  }
  return addMonthsToDateString(startDate, tenorMonths);
}

/** Whole days between two 'YYYY-MM-DD' date strings (to >= from). */
function daysBetween(fromDateStr, toDateStr) {
  const from = new Date(`${fromDateStr}T00:00:00Z`);
  const to = new Date(`${toDateStr}T00:00:00Z`);
  const days = Math.round((to - from) / 86400000);
  if (days < 0) throw new Error('toDateStr must not be before fromDateStr');
  return days;
}

/** asOfDateStr is "early" (before maturity) relative to maturityDateStr. */
function isEarlyRedemption(asOfDateStr, maturityDateStr) {
  return new Date(`${asOfDateStr}T00:00:00Z`) < new Date(`${maturityDateStr}T00:00:00Z`);
}

/**
 * Simple interest accrual for a period: principal * (annualRateBps/10000)
 * * (days/365), rounded to the nearest pesewa. Investments don't
 * compound — each accrual is computed on the ORIGINAL principal, not on
 * a running balance that includes prior accruals (a fixed-term deposit,
 * not a compounding one).
 */
function computeAccrualPesewas({ principalPesewas, annualInterestRateBps, days }) {
  if (!Number.isInteger(principalPesewas) || principalPesewas <= 0) {
    throw new Error('principalPesewas must be a positive integer');
  }
  if (!Number.isInteger(annualInterestRateBps) || annualInterestRateBps < 0) {
    throw new Error('annualInterestRateBps must be a non-negative integer');
  }
  if (!Number.isInteger(days) || days <= 0) {
    throw new Error('days must be a positive integer');
  }
  return Math.round((principalPesewas * annualInterestRateBps * days) / (365 * 10000));
}

/**
 * Computes the redemption payout: principal is ALWAYS returned in full
 * (never penalized — see Decisions_Log.md); an early redemption forfeits
 * `penaltyRateBps` of the ACCRUED INTEREST only. A redemption at or after
 * maturity (`isEarly: false`) never applies a penalty regardless of the
 * product's configured rate.
 */
function computeRedemptionPesewas({ principalPesewas, accruedInterestPesewas, isEarly, penaltyRateBps }) {
  if (!Number.isInteger(principalPesewas) || principalPesewas <= 0) {
    throw new Error('principalPesewas must be a positive integer');
  }
  if (!Number.isInteger(accruedInterestPesewas) || accruedInterestPesewas < 0) {
    throw new Error('accruedInterestPesewas must be a non-negative integer');
  }
  const rateBps = isEarly ? Number(penaltyRateBps) || 0 : 0;
  const penaltyPesewas = Math.round((accruedInterestPesewas * rateBps) / 10000);
  const interestPayablePesewas = accruedInterestPesewas - penaltyPesewas;
  return {
    penaltyPesewas,
    interestPayablePesewas,
    totalPayoutPesewas: principalPesewas + interestPayablePesewas,
  };
}

module.exports = {
  addMonthsToDateString,
  computeMaturityDate,
  daysBetween,
  isEarlyRedemption,
  computeAccrualPesewas,
  computeRedemptionPesewas,
};
