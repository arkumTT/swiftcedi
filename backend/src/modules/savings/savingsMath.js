'use strict';

/**
 * Pure savings/susu math for Module 4 — no db, no side effects. Split out
 * from the services for the same reason as Module 3's loanMath.js: the
 * charge, commission and scheduling rules are exactly the business logic
 * CLAUDE.md wants unit-tested alongside the implementation.
 */

const CHARGE_FIELDS = [
  'minBalancePesewas',
  'maintenanceFeePesewas',
  'withdrawalFeePesewas',
  'minBalanceChargePesewas',
  'withdrawalApprovalThresholdPesewas',
];

/**
 * Resolves the charge configuration for an account: the product's columns,
 * overlaid by any non-null per-account `charges_config` override.
 */
function resolveChargesConfig(product, accountChargesConfig) {
  const base = {
    minBalancePesewas: Number(product.min_balance_pesewas),
    maintenanceFeePesewas: Number(product.maintenance_fee_pesewas),
    withdrawalFeePesewas: Number(product.withdrawal_fee_pesewas),
    minBalanceChargePesewas: Number(product.min_balance_charge_pesewas),
    withdrawalApprovalThresholdPesewas: Number(product.withdrawal_approval_threshold_pesewas),
  };
  if (!accountChargesConfig) return base;
  const merged = { ...base };
  for (const field of CHARGE_FIELDS) {
    const override = accountChargesConfig[field];
    if (override !== undefined && override !== null) merged[field] = Number(override);
  }
  return merged;
}

/**
 * Resolves the effective withdrawal approval threshold. Business rule:
 * "configurable per branch or per product, not hardcoded". Resolution
 * order (most specific wins):
 *   1. a matching `approval_thresholds` row (Module 11) — which itself
 *      already prefers a branch-specific row over the org-wide one
 *   2. the account/product charge config
 * Returns the threshold in pesewas; an amount >= threshold needs approval.
 */
function resolveWithdrawalThresholdPesewas(approvalThresholdRow, chargesConfig) {
  if (approvalThresholdRow && approvalThresholdRow.amount_threshold_pesewas !== undefined) {
    return Number(approvalThresholdRow.amount_threshold_pesewas);
  }
  return Number(chargesConfig.withdrawalApprovalThresholdPesewas);
}

/** A withdrawal needs maker-checker approval once it reaches the threshold. */
function withdrawalNeedsApproval(amountPesewas, thresholdPesewas) {
  return Number(amountPesewas) >= Number(thresholdPesewas);
}

/**
 * Validates a withdrawal against the balance and the product's minimum
 * balance, INCLUDING any withdrawal fee (the fee comes out of the same
 * account, so it must fit too). Returns the fee so callers don't
 * re-derive it.
 *
 * `overdraftLimitPesewas` is the account's REAL, numeric overdraft ceiling
 * (savings_accounts.overdraft_limit_pesewas — 0 unless an overdraft loan is
 * actually disbursed against this account). The floor a withdrawal must
 * respect is `minBalance - overdraftLimitPesewas`, never an unconditional
 * bypass — a previous version of this function skipped the check entirely
 * for any allows_overdraft product, giving every such account an
 * unlimited, unattached overdraft. See Decisions_Log.md.
 */
function assessWithdrawal({ balancePesewas, amountPesewas, chargesConfig, overdraftLimitPesewas = 0 }) {
  const balance = Number(balancePesewas);
  const amount = Number(amountPesewas);
  const feePesewas = Number(chargesConfig.withdrawalFeePesewas) || 0;
  const totalDebit = amount + feePesewas;
  const balanceAfter = balance - totalDebit;
  const minBalance = Number(chargesConfig.minBalancePesewas) || 0;
  const overdraftLimit = Number(overdraftLimitPesewas) || 0;
  const floor = minBalance - overdraftLimit;

  let error = null;
  if (!Number.isInteger(amount) || amount <= 0) {
    error = 'amountPesewas must be a positive integer';
  } else if (balanceAfter < floor) {
    error =
      overdraftLimit > 0
        ? `insufficient funds: withdrawing ${amount} (+${feePesewas} fee) would leave ${balanceAfter}, below the ${floor} floor (${minBalance} minimum balance less ${overdraftLimit} overdraft limit)`
        : minBalance > 0
        ? `insufficient funds: withdrawing ${amount} (+${feePesewas} fee) would leave ${balanceAfter}, below the ${minBalance} minimum balance`
        : `insufficient funds: withdrawing ${amount} (+${feePesewas} fee) exceeds the available balance of ${balance}`;
  }

  return { ok: error === null, error, feePesewas, totalDebitPesewas: totalDebit, balanceAfterPesewas: balanceAfter };
}

/**
 * The minimum-balance charge applies only when the balance has fallen
 * below the configured minimum. Returns 0 when it doesn't apply, and never
 * charges more than the remaining balance (a charge must not itself
 * overdraw the account).
 */
function computeMinBalanceChargePesewas(balancePesewas, chargesConfig) {
  const balance = Number(balancePesewas);
  const minBalance = Number(chargesConfig.minBalancePesewas) || 0;
  const charge = Number(chargesConfig.minBalanceChargePesewas) || 0;
  if (minBalance <= 0 || charge <= 0 || balance >= minBalance) return 0;
  return Math.max(Math.min(charge, balance), 0);
}

/** Maintenance fee, likewise capped at the available balance. */
function computeMaintenanceFeePesewas(balancePesewas, chargesConfig) {
  const fee = Number(chargesConfig.maintenanceFeePesewas) || 0;
  if (fee <= 0) return 0;
  return Math.max(Math.min(fee, Number(balancePesewas)), 0);
}

/** Agent commission on a single collection, in integer pesewas. */
function computeCommissionPesewas(collectionAmountPesewas, commissionRateBps) {
  const amount = Number(collectionAmountPesewas);
  const bps = Number(commissionRateBps) || 0;
  if (amount <= 0 || bps <= 0) return 0;
  return Math.round((amount * bps) / 10000);
}

/**
 * A susu cycle is 'completed' when the target was reached, 'uncompleted'
 * when the cycle ended short. Deliberately based on the amount collected
 * against target, not on how many visits happened.
 */
function resolveCycleOutcome(collectedPesewas, targetAmountPesewas) {
  return Number(collectedPesewas) >= Number(targetAmountPesewas) ? 'completed' : 'uncompleted';
}

function addDaysToDateString(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Next run date for a standing order. Monthly uses the same
 * clamp-to-month-end rule as loan schedules (Jan 31 -> Feb 28), so the two
 * modules never disagree about what "a month later" means.
 */
function nextRunDate(fromDateStr, frequency) {
  if (frequency === 'daily') return addDaysToDateString(fromDateStr, 1);
  if (frequency === 'weekly') return addDaysToDateString(fromDateStr, 7);
  if (frequency === 'monthly') {
    const d = new Date(`${fromDateStr}T00:00:00Z`);
    const day = d.getUTCDate();
    d.setUTCMonth(d.getUTCMonth() + 1);
    if (d.getUTCDate() !== day) d.setUTCDate(0);
    return d.toISOString().slice(0, 10);
  }
  throw new Error(`unknown frequency '${frequency}'`);
}

module.exports = {
  resolveChargesConfig,
  resolveWithdrawalThresholdPesewas,
  withdrawalNeedsApproval,
  assessWithdrawal,
  computeMinBalanceChargePesewas,
  computeMaintenanceFeePesewas,
  computeCommissionPesewas,
  resolveCycleOutcome,
  addDaysToDateString,
  nextRunDate,
};
