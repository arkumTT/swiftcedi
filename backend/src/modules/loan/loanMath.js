'use strict';

/**
 * Pure loan math for Module 3 — no db, no side effects. Kept separate from
 * loanService.js so the interest/schedule/allocation logic (the part the
 * module spec explicitly calls out for dedicated unit tests) is trivially
 * testable in isolation.
 */

/** Adds `months` to a 'YYYY-MM-DD' date string, clamping to the target month's last day on overflow (e.g. Jan 31 + 1 month -> Feb 28/29, not Mar 3). */
function addMonthsToDateString(dateStr, months) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const originalDay = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  if (d.getUTCDate() !== originalDay) {
    d.setUTCDate(0); // rolled into the month after target — snap back to target month's last day
  }
  return d.toISOString().slice(0, 10);
}

/**
 * Flat-rate schedule: total interest = principal * annual_rate * (term/12),
 * split evenly across installments. Both principal and interest have their
 * rounding remainder absorbed by the LAST installment, so
 * sum(principalDue) === principalPesewas and sum(interestDue) === the
 * exact computed total interest — no drift regardless of term/rate.
 */
function generateFlatSchedule({ principalPesewas, termMonths, annualInterestRateBps, startDate }) {
  const totalInterestPesewas = Math.round((principalPesewas * annualInterestRateBps * termMonths) / (12 * 10000));
  const basePrincipal = Math.floor(principalPesewas / termMonths);
  const baseInterest = Math.floor(totalInterestPesewas / termMonths);

  const rows = [];
  let principalAccum = 0;
  let interestAccum = 0;
  for (let i = 1; i <= termMonths; i++) {
    const isLast = i === termMonths;
    const principalDuePesewas = isLast ? principalPesewas - principalAccum : basePrincipal;
    const interestDuePesewas = isLast ? totalInterestPesewas - interestAccum : baseInterest;
    principalAccum += principalDuePesewas;
    interestAccum += interestDuePesewas;
    rows.push({ installmentNumber: i, dueDate: addMonthsToDateString(startDate, i), principalDuePesewas, interestDuePesewas });
  }
  return rows;
}

/**
 * Reducing-balance (amortizing) schedule: a level monthly installment
 * computed via the standard annuity formula, with interest each period
 * calculated on the REMAINING balance (rounded to the nearest pesewa) and
 * principal = installment - interest. The last installment always pays
 * off whatever balance remains exactly (principalDue = balance), which is
 * the anti-drift guarantee: sum(principalDue) === principalPesewas always,
 * by construction, regardless of rounding anywhere else in the schedule —
 * this is what the module spec's "must handle ... without drifting from
 * the original schedule's total interest assumptions" requires.
 */
function generateReducingBalanceSchedule({ principalPesewas, termMonths, annualInterestRateBps, startDate }) {
  const monthlyRate = annualInterestRateBps / 12 / 10000;

  let installmentAmount;
  if (monthlyRate === 0) {
    installmentAmount = Math.round(principalPesewas / termMonths);
  } else {
    const factor = (1 + monthlyRate) ** termMonths;
    installmentAmount = Math.round((principalPesewas * monthlyRate * factor) / (factor - 1));
  }

  const rows = [];
  let balance = principalPesewas;
  for (let i = 1; i <= termMonths; i++) {
    const isLast = i === termMonths;
    const interestDuePesewas = Math.round(balance * monthlyRate);
    let principalDuePesewas = isLast ? balance : Math.min(installmentAmount - interestDuePesewas, balance);
    if (principalDuePesewas < 0) principalDuePesewas = 0; // guard: pathological high-rate/short-remainder edge case
    balance -= principalDuePesewas;
    rows.push({ installmentNumber: i, dueDate: addMonthsToDateString(startDate, i), principalDuePesewas, interestDuePesewas });
  }
  return rows;
}

/** Adds `days` to a 'YYYY-MM-DD' date string. */
function addDaysToDateString(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Non-monthly cadences are approximated in whole days (a 30-day month,
// 7-day week) rather than tracked against a real calendar, the same kind
// of deliberate simplification this codebase already makes elsewhere
// (overdraft interest uses a 365-day year, not actual days-in-year) —
// see loan_products migration 060's comment for the offer-facing side of
// this. The MONTHLY path above is unaffected and still uses real
// calendar months via addMonthsToDateString.
const PERIOD_DAYS = { daily: 1, weekly: 7, biweekly: 14, monthly: 30 };
const DURATION_UNIT_DAYS = { days: 1, weeks: 7, months: 30 };

/**
 * Flat-rate schedule generalized to an arbitrary fixed period length (in
 * days) instead of calendar months — same anti-drift construction as
 * generateFlatSchedule (both principal and interest rounding remainders
 * absorbed by the last installment).
 */
function generateFlatScheduleByPeriod({ principalPesewas, numInstallments, periodDays, annualInterestRateBps, startDate }) {
  const totalInterestPesewas = Math.round(
    (principalPesewas * annualInterestRateBps * numInstallments * periodDays) / (365 * 10000)
  );
  const basePrincipal = Math.floor(principalPesewas / numInstallments);
  const baseInterest = Math.floor(totalInterestPesewas / numInstallments);

  const rows = [];
  let principalAccum = 0;
  let interestAccum = 0;
  for (let i = 1; i <= numInstallments; i++) {
    const isLast = i === numInstallments;
    const principalDuePesewas = isLast ? principalPesewas - principalAccum : basePrincipal;
    const interestDuePesewas = isLast ? totalInterestPesewas - interestAccum : baseInterest;
    principalAccum += principalDuePesewas;
    interestAccum += interestDuePesewas;
    rows.push({ installmentNumber: i, dueDate: addDaysToDateString(startDate, i * periodDays), principalDuePesewas, interestDuePesewas });
  }
  return rows;
}

/**
 * Reducing-balance schedule generalized to an arbitrary fixed period
 * length (in days) — same annuity-formula/anti-drift construction as
 * generateReducingBalanceSchedule, with the period rate computed as
 * annualRate * (periodDays/365) instead of annualRate/12.
 */
function generateReducingBalanceScheduleByPeriod({ principalPesewas, numInstallments, periodDays, annualInterestRateBps, startDate }) {
  const periodRate = (annualInterestRateBps / 10000) * (periodDays / 365);

  let installmentAmount;
  if (periodRate === 0) {
    installmentAmount = Math.round(principalPesewas / numInstallments);
  } else {
    const factor = (1 + periodRate) ** numInstallments;
    installmentAmount = Math.round((principalPesewas * periodRate * factor) / (factor - 1));
  }

  const rows = [];
  let balance = principalPesewas;
  for (let i = 1; i <= numInstallments; i++) {
    const isLast = i === numInstallments;
    const interestDuePesewas = Math.round(balance * periodRate);
    let principalDuePesewas = isLast ? balance : Math.min(installmentAmount - interestDuePesewas, balance);
    if (principalDuePesewas < 0) principalDuePesewas = 0;
    balance -= principalDuePesewas;
    rows.push({ installmentNumber: i, dueDate: addDaysToDateString(startDate, i * periodDays), principalDuePesewas, interestDuePesewas });
  }
  return rows;
}

function generateLoanSchedule({
  principalPesewas,
  termMonths,
  annualInterestRateBps,
  interestMethod,
  startDate,
  repaymentFrequency = 'monthly',
  durationUnit = 'months',
}) {
  if (!Number.isInteger(principalPesewas) || principalPesewas <= 0) {
    throw new Error('principalPesewas must be a positive integer');
  }
  if (!Number.isInteger(termMonths) || termMonths <= 0) {
    throw new Error('termMonths must be a positive integer');
  }
  if (!Number.isInteger(annualInterestRateBps) || annualInterestRateBps < 0) {
    throw new Error('annualInterestRateBps must be a non-negative integer');
  }

  // The original, unchanged monthly-calendar path — every pre-existing
  // caller (still the overwhelming majority: every product whose offer
  // never opted into a non-monthly cadence) hits this branch and gets
  // byte-identical output to before this function grew frequency/duration
  // support, using real calendar months rather than the 30-day
  // approximation the non-monthly branch below uses.
  if (repaymentFrequency === 'monthly' && durationUnit === 'months') {
    if (interestMethod === 'flat') {
      return generateFlatSchedule({ principalPesewas, termMonths, annualInterestRateBps, startDate });
    }
    if (interestMethod === 'reducing_balance') {
      return generateReducingBalanceSchedule({ principalPesewas, termMonths, annualInterestRateBps, startDate });
    }
    throw new Error(`unknown interestMethod '${interestMethod}'`);
  }

  if (!PERIOD_DAYS[repaymentFrequency]) {
    throw new Error(`unknown repaymentFrequency '${repaymentFrequency}'`);
  }
  if (!DURATION_UNIT_DAYS[durationUnit]) {
    throw new Error(`unknown durationUnit '${durationUnit}'`);
  }

  const periodDays = PERIOD_DAYS[repaymentFrequency];
  const totalDays = termMonths * DURATION_UNIT_DAYS[durationUnit];
  const numInstallments = Math.max(1, Math.round(totalDays / periodDays));

  if (interestMethod === 'flat') {
    return generateFlatScheduleByPeriod({ principalPesewas, numInstallments, periodDays, annualInterestRateBps, startDate });
  }
  if (interestMethod === 'reducing_balance') {
    return generateReducingBalanceScheduleByPeriod({ principalPesewas, numInstallments, periodDays, annualInterestRateBps, startDate });
  }
  throw new Error(`unknown interestMethod '${interestMethod}'`);
}

/**
 * Waterfall allocation of a repayment across ordered (oldest-first)
 * outstanding schedule rows: fees, then interest, then principal per
 * installment, spilling over to the next installment once one is fully
 * covered. This is what keeps early/partial/late payments from ever
 * requiring the schedule itself to be recalculated — installment amounts
 * are fixed at generation time and this function only decides how a given
 * payment covers them, so "the original schedule's total interest
 * assumptions" never drift regardless of payment timing.
 *
 * @param {Array<{id, principalDuePesewas, principalPaidPesewas, interestDuePesewas, interestPaidPesewas, feesDuePesewas, feesPaidPesewas}>} scheduleRows
 * @param {number} amountPesewas
 * @returns {{ allocations: Array<{scheduleId, feesPaidPesewas, interestPaidPesewas, principalPaidPesewas}>, unallocatedPesewas: number }}
 */
function allocateRepayment(scheduleRows, amountPesewas) {
  if (!Number.isInteger(amountPesewas) || amountPesewas <= 0) {
    throw new Error('amountPesewas must be a positive integer');
  }

  let remaining = amountPesewas;
  const allocations = [];

  for (const row of scheduleRows) {
    if (remaining <= 0) break;

    const feesOutstanding = Math.max(row.feesDuePesewas - row.feesPaidPesewas, 0);
    const interestOutstanding = Math.max(row.interestDuePesewas - row.interestPaidPesewas, 0);
    const principalOutstanding = Math.max(row.principalDuePesewas - row.principalPaidPesewas, 0);
    if (feesOutstanding === 0 && interestOutstanding === 0 && principalOutstanding === 0) continue;

    const feesPaidPesewas = Math.min(remaining, feesOutstanding);
    remaining -= feesPaidPesewas;
    const interestPaidPesewas = Math.min(remaining, interestOutstanding);
    remaining -= interestPaidPesewas;
    const principalPaidPesewas = Math.min(remaining, principalOutstanding);
    remaining -= principalPaidPesewas;

    if (feesPaidPesewas > 0 || interestPaidPesewas > 0 || principalPaidPesewas > 0) {
      allocations.push({ scheduleId: row.id, feesPaidPesewas, interestPaidPesewas, principalPaidPesewas });
    }
  }

  return { allocations, unallocatedPesewas: remaining };
}

/** Total remaining principal across the given schedule rows. */
function computeOutstandingPrincipalPesewas(scheduleRows) {
  return scheduleRows.reduce((sum, row) => sum + (row.principalDuePesewas - row.principalPaidPesewas), 0);
}

/**
 * Buckets a days-overdue count using ascending boundaries, e.g. [30,60,90]
 * -> "1-30" / "31-60" / "61-90" / "90+". Returns null for daysOverdue <= 0
 * (not overdue). These are configurable portfolio-management buckets, not
 * BOG's prudential loan classification categories (see loan_products
 * migration comment).
 */
function bucketArrearsDays(daysOverdue, bucketBoundaryDays) {
  if (daysOverdue <= 0) return null;
  const sorted = [...bucketBoundaryDays].sort((a, b) => a - b);
  let lower = 1;
  for (const boundary of sorted) {
    if (daysOverdue <= boundary) return `${lower}-${boundary}`;
    lower = boundary + 1;
  }
  return `${sorted[sorted.length - 1]}+`;
}

/**
 * Sums a product's fee_schedule against a principal. Each fee is either
 * `{ type: 'flat', amountPesewas }` or `{ type: 'percent_of_principal',
 * rateBps }`. Fees are charged once, at disbursement, netted from the
 * disbursed cash — see Decisions_Log.md.
 */
function computeFeesPesewas(feeSchedule, principalPesewas) {
  return (feeSchedule || []).reduce((total, fee) => {
    if (fee.type === 'flat') return total + (fee.amountPesewas || 0);
    if (fee.type === 'percent_of_principal') return total + Math.round((principalPesewas * (fee.rateBps || 0)) / 10000);
    throw new Error(`unknown fee type '${fee.type}'`);
  }, 0);
}

/**
 * Simple daily interest on a drawn overdraft balance for a given number of
 * days: drawnBalancePesewas * (annualRateBps/10000) * (days/365), rounded
 * to the nearest pesewa. Overdrafts have no schedule to amortize against,
 * so — unlike term loans (interest recognized on receipt) — this accrual
 * IS the interest recognition event; see Decisions_Log.md.
 */
function computeOverdraftInterestPesewas({ drawnBalancePesewas, annualInterestRateBps, days }) {
  if (!Number.isInteger(drawnBalancePesewas) || drawnBalancePesewas <= 0) {
    throw new Error('drawnBalancePesewas must be a positive integer');
  }
  if (!Number.isInteger(annualInterestRateBps) || annualInterestRateBps < 0) {
    throw new Error('annualInterestRateBps must be a non-negative integer');
  }
  if (!Number.isInteger(days) || days <= 0) {
    throw new Error('days must be a positive integer');
  }
  return Math.round((drawnBalancePesewas * annualInterestRateBps * days) / (365 * 10000));
}

/**
 * A floating product's effective nominal annual rate: the linked
 * reference (policy) rate plus the product's own spread/margin. The one
 * formula used both when a product's listing rate is (re)computed
 * (loanService.resetFloatingRateProducts) and when a floating concession
 * needs to know what its negotiated spread actually resolves to.
 */
function computeFloatingEffectiveRateBps({ referenceRateBps, spreadBps }) {
  if (!Number.isInteger(referenceRateBps) || referenceRateBps < 0) {
    throw new Error('referenceRateBps must be a non-negative integer');
  }
  if (!Number.isInteger(spreadBps) || spreadBps < 0) {
    throw new Error('spreadBps must be a non-negative integer');
  }
  return referenceRateBps + spreadBps;
}

/**
 * Pure decision function for a proposed loan concession — does not
 * enforce anything itself; loanService turns the result into either a
 * rejection, an immediate application, or a maker-checker approval
 * request. Kept separate from that side-effecting logic so the actual
 * bound/threshold arithmetic (the part most worth getting exactly right)
 * is directly unit-testable in isolation, same reasoning as every other
 * function in this file.
 *
 * For a FIXED product, compare the negotiated RATE against the product's
 * min_rate_floor_bps. For a FLOATING product, compare the negotiated
 * SPREAD against min_spread_floor_bps instead — an officer only ever
 * negotiates the bank's own margin, never the reference rate itself, so
 * floating concessions are evaluated on spread, not the blended rate.
 *
 * A concession is always a discount relative to standard — a negotiated
 * value above standard is never "permitted" (that's a markup, not a
 * concession) regardless of where the floor sits.
 *
 * @returns {{ permitted: boolean, withinFloor: boolean, appliedFloorBps: number|null, deltaBps: number, needsApproval: boolean }}
 *   `deltaBps` is the size of the discount (standard - negotiated, so a
 *   larger positive number is a bigger discount). `needsApproval` is
 *   true whenever the concession is permitted but the discount exceeds
 *   the product's concessionApprovalThresholdBps grace window, OR the
 *   term or fee schedule was also changed (those aren't bounded the same
 *   way a rate/spread is, so any change to them routes to approval by
 *   default rather than trying to quantify how "big" a fee waiver is).
 */
function evaluateConcessionBounds({
  rateType,
  standardAnnualInterestRateBps,
  negotiatedAnnualInterestRateBps,
  standardSpreadBps = null,
  negotiatedSpreadBps = null,
  minRateFloorBps = null,
  minSpreadFloorBps = null,
  concessionApprovalThresholdBps,
  termChanged = false,
  feesChanged = false,
}) {
  if (rateType !== 'fixed' && rateType !== 'floating') {
    throw new Error(`unknown rateType '${rateType}'`);
  }
  if (!Number.isInteger(concessionApprovalThresholdBps) || concessionApprovalThresholdBps < 0) {
    throw new Error('concessionApprovalThresholdBps must be a non-negative integer');
  }

  const floorBps = rateType === 'fixed' ? minRateFloorBps : minSpreadFloorBps;
  const standardValueBps = rateType === 'fixed' ? standardAnnualInterestRateBps : standardSpreadBps;
  const negotiatedValueBps = rateType === 'fixed' ? negotiatedAnnualInterestRateBps : negotiatedSpreadBps;

  if (!Number.isInteger(standardValueBps) || !Number.isInteger(negotiatedValueBps)) {
    throw new Error(
      rateType === 'fixed'
        ? 'standardAnnualInterestRateBps and negotiatedAnnualInterestRateBps must be integers'
        : 'standardSpreadBps and negotiatedSpreadBps must be integers'
    );
  }

  // No floor configured on the product at all means concessions aren't
  // permitted on it, full stop — not "permitted with no limit".
  if (floorBps === null || floorBps === undefined) {
    return { permitted: false, withinFloor: false, appliedFloorBps: null, deltaBps: 0, needsApproval: false };
  }

  const deltaBps = standardValueBps - negotiatedValueBps;
  if (deltaBps < 0) {
    // A negotiated value above standard is a markup, never a concession.
    return { permitted: false, withinFloor: false, appliedFloorBps: floorBps, deltaBps, needsApproval: false };
  }

  const withinFloor = negotiatedValueBps >= floorBps;
  const needsApproval = withinFloor && (deltaBps > concessionApprovalThresholdBps || termChanged || feesChanged);

  return { permitted: withinFloor, withinFloor, appliedFloorBps: floorBps, deltaBps, needsApproval };
}

/**
 * Amount for a single basis/amount/rate-pair field — the shape
 * processing_fee_*, insurance_fee_*, and default_charge_* all share (see
 * migration 060) — as opposed to computeFeesPesewas, which sums an
 * ARRAY of such fees (the generic fee_schedule column). 'flat' returns
 * amountPesewas as-is; 'percent_of_principal' computes rateBps against
 * the given principal.
 */
function computeFeeAmountPesewas({ basis, amountPesewas = null, rateBps = null, principalPesewas }) {
  if (basis === 'flat') return amountPesewas || 0;
  if (basis === 'percent_of_principal') return Math.round((principalPesewas * (rateBps || 0)) / 10000);
  throw new Error(`unknown basis '${basis}'`);
}

/**
 * Loan module amendment (item 5): decides the loan's ACTIVE sub-status —
 * 'paying' (current) or 'missed_payment' (at least one unpaid installment
 * past its OWN due date plus installmentGracePeriodDays) — from that
 * loan's schedule. Pure and side-effect-free so loanService.refreshLoanStatus
 * can call it and only issue an UPDATE when the result actually differs
 * from what's stored; called at read-time (getLoan/listLoans) and after
 * postRepayment, not from a cron (see Decisions_Log.md — a daily
 * auto-flag job was explicitly deferred, not built).
 *
 * Deliberately distinct from repaymentGracePeriodDays (days after
 * DISBURSEMENT before the first installment obligation starts at all) —
 * that's a scheduling concern handled when the schedule is generated, not
 * a status-recompute concern; see migration 060's comment for the
 * distinction between the two grace periods.
 *
 * @param {Array<{dueDate: string, status: string}>} scheduleRows
 */
function computeActiveLoanStatus({ scheduleRows, installmentGracePeriodDays, asOfDate }) {
  const hasMissedInstallment = scheduleRows.some((row) => {
    if (row.status === 'paid') return false;
    const graceDeadline = addDaysToDateString(row.dueDate, installmentGracePeriodDays);
    return graceDeadline <= asOfDate;
  });
  return hasMissedInstallment ? 'missed_payment' : 'paying';
}

module.exports = {
  addMonthsToDateString,
  addDaysToDateString,
  generateLoanSchedule,
  allocateRepayment,
  computeOutstandingPrincipalPesewas,
  bucketArrearsDays,
  computeFeesPesewas,
  computeFeeAmountPesewas,
  computeOverdraftInterestPesewas,
  computeFloatingEffectiveRateBps,
  evaluateConcessionBounds,
  computeActiveLoanStatus,
};
