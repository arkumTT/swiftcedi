'use strict';

const auditLog = require('../../shared/auditLog');
const approvalWorkflow = require('../../shared/approvalWorkflow');
const glPosting = require('../../shared/glPosting');
const investmentMath = require('./investmentMath');

/**
 * Module 5: Investment Module. Uses the Module 11/7 shared services
 * exactly as documented in Decisions_Log.md.
 *
 * Investments are booked as a LIABILITY (Investment Deposits Payable) —
 * principal owed back to the investor, not equity — see Decisions_Log.md.
 *
 * GL mapping (see Decisions_Log.md):
 *   Activation (funds received)  Dr Cash in Hand              Cr Investment Deposits Payable
 *   Interest accrual             Dr Investment Interest Expense Cr Investment Deposits Payable
 *   Periodic interest payout     Dr Investment Deposits Payable Cr Cash in Hand
 *   Redemption (early or at maturity):
 *     Dr Investment Deposits Payable  principal + accrued interest (extinguishes the full liability)
 *       Cr Cash in Hand                 total payout (principal + interest payable)
 *       Cr Early Withdrawal Penalty Income  penalty (if any, early only)
 *
 * Booking and redemption ALWAYS require maker-checker approval (the
 * module spec's "pending-approval queue for new investments and
 * disinvestments" — no threshold escape hatch, same treatment as
 * loan.approve). Periodic interest payouts are threshold-gated, same
 * convention as Module 4's savings.withdraw.
 *
 * No live payments integration exists yet (Module 7's payments layer /
 * MoMo/GHIPSS/Paystack/Hubtel — see Decisions_Log.md's Suggested Build
 * Order), so "the payment layer confirms the transfer succeeded" is
 * modeled as an explicit staff confirmation step (payment_reference is a
 * manually-entered MoMo/bank reference or cashier voucher number) rather
 * than an automated callback — flagged in Open Questions.
 */

class InvestmentValidationError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 400;
  }
}
class InvestmentNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 404;
  }
}
class InvestmentConflictError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 409;
  }
}

const todayIso = () => new Date().toISOString().slice(0, 10);

/**
 * node-postgres returns DATE columns as JS Date objects, not 'YYYY-MM-DD'
 * strings — normalize before handing a DB-read date to investmentMath's
 * string-based date arithmetic (which does `` `${d}T00:00:00Z` ``; fed a
 * raw Date object that stringifies via its default toString(), that
 * produces an Invalid Date and every comparison against it silently
 * returns false). Accepts either shape so it's also a no-op on a plain
 * 'YYYY-MM-DD' string coming from a request body.
 */
function toDateString(dateOrString) {
  if (dateOrString instanceof Date) return dateOrString.toISOString().slice(0, 10);
  return String(dateOrString).slice(0, 10);
}

// --- Investment products -----------------------------------------------------

async function createInvestmentProduct(pool, params) {
  const {
    name,
    code,
    tenorMonths,
    annualInterestRateBps,
    minPrincipalPesewas,
    maxPrincipalPesewas = null,
    payoutFrequency,
    earlyWithdrawalPenaltyBps = 0,
    payoutApprovalThresholdPesewas = 0,
    createdBy,
  } = params;

  if (!name || !code || !payoutFrequency || !createdBy) {
    throw new InvestmentValidationError('name, code, payoutFrequency, and createdBy are required');
  }
  if (!['monthly', 'at_maturity'].includes(payoutFrequency)) {
    throw new InvestmentValidationError("payoutFrequency must be 'monthly' or 'at_maturity'");
  }

  const { rows } = await pool.query(
    `INSERT INTO investment_products
       (name, code, tenor_months, annual_interest_rate_bps, min_principal_pesewas, max_principal_pesewas,
        payout_frequency, early_withdrawal_penalty_bps, payout_approval_threshold_pesewas, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      name,
      String(code).toUpperCase(),
      tenorMonths,
      annualInterestRateBps,
      minPrincipalPesewas,
      maxPrincipalPesewas,
      payoutFrequency,
      earlyWithdrawalPenaltyBps,
      payoutApprovalThresholdPesewas,
      createdBy,
    ]
  );
  return rows[0];
}

async function getInvestmentProduct(db, productId) {
  const { rows } = await db.query('SELECT * FROM investment_products WHERE id = $1', [productId]);
  if (!rows[0]) throw new InvestmentNotFoundError(`investment_product ${productId} not found`);
  return rows[0];
}

async function listInvestmentProducts(pool, { status } = {}) {
  const params = [];
  let where = '';
  if (status) {
    params.push(status);
    where = 'WHERE status = $1';
  }
  const { rows } = await pool.query(`SELECT * FROM investment_products ${where} ORDER BY code`, params);
  return rows;
}

function assertWithinProductLimits(product, principalPesewas) {
  if (!Number.isInteger(principalPesewas) || principalPesewas <= 0) {
    throw new InvestmentValidationError('principalPesewas must be a positive integer');
  }
  const min = Number(product.min_principal_pesewas);
  const max = product.max_principal_pesewas === null ? null : Number(product.max_principal_pesewas);
  if (principalPesewas < min || (max !== null && principalPesewas > max)) {
    throw new InvestmentValidationError(
      `principalPesewas ${principalPesewas} is outside product limits (${min}-${max === null ? 'uncapped' : max})`
    );
  }
}

// --- Branch GL accounts -------------------------------------------------------

async function getBranchGlAccounts(db, branchId) {
  const { rows } = await db.query('SELECT * FROM branch_gl_accounts WHERE branch_id = $1', [branchId]);
  if (!rows[0]) throw new InvestmentNotFoundError(`branch ${branchId} has no branch_gl_accounts row`);
  return rows[0];
}

// --- Investments --------------------------------------------------------------

async function getInvestment(pool, investmentId) {
  const { rows } = await pool.query('SELECT * FROM investments WHERE id = $1', [investmentId]);
  if (!rows[0]) throw new InvestmentNotFoundError(`investment ${investmentId} not found`);
  return rows[0];
}

async function listInvestments(pool, { customerId, branchId, status, productId } = {}) {
  const clauses = [];
  const params = [];
  const add = (col, val) => {
    if (val === undefined || val === null) return;
    params.push(val);
    clauses.push(`${col} = $${params.length}`);
  };
  add('customer_id', customerId);
  add('branch_id', branchId);
  add('status', status);
  add('product_id', productId);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await pool.query(`SELECT * FROM investments ${where} ORDER BY created_at DESC`, params);
  return rows;
}

/**
 * Books a new investment application: validates the customer/product,
 * snapshots the product's terms onto the investment row, and immediately
 * requests maker-checker approval (the spec's "pending-approval queue for
 * new investments" — no separate appraisal step, unlike loans). Nothing
 * is funded and no GL entry is posted here — see `activateInvestment`.
 */
async function bookInvestment(pool, { customerId, productId, principalPesewas, appliedBy }) {
  if (!customerId || !productId || !appliedBy) {
    throw new InvestmentValidationError('customerId, productId, and appliedBy are required');
  }

  const product = await getInvestmentProduct(pool, productId);
  if (product.status !== 'active') {
    throw new InvestmentConflictError(`investment_product ${productId} is not active`);
  }
  assertWithinProductLimits(product, principalPesewas);

  const { rows: customerRows } = await pool.query('SELECT * FROM customers WHERE id = $1', [customerId]);
  const customer = customerRows[0];
  if (!customer) throw new InvestmentValidationError(`customer ${customerId} not found`);
  if (customer.status !== 'active') {
    throw new InvestmentConflictError(`customer ${customerId} is not active (status: ${customer.status})`);
  }
  if (customer.kyc_status !== 'verified') {
    throw new InvestmentConflictError(`customer ${customerId} must be KYC-verified before investing`);
  }

  const { rows } = await pool.query(
    `INSERT INTO investments
       (customer_id, branch_id, product_id, principal_pesewas, tenor_months, annual_interest_rate_bps,
        payout_frequency, early_withdrawal_penalty_bps, applied_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      customerId,
      customer.branch_id,
      productId,
      principalPesewas,
      product.tenor_months,
      product.annual_interest_rate_bps,
      product.payout_frequency,
      product.early_withdrawal_penalty_bps,
      appliedBy,
    ]
  );
  const investment = rows[0];

  await auditLog.record(pool, {
    userId: appliedBy,
    branchId: investment.branch_id,
    action: 'investment.applied',
    entityType: 'investment',
    entityId: investment.id,
    afterState: investment,
  });

  const approvalRequest = await approvalWorkflow.requestApproval(pool, {
    actionType: 'investment.book',
    entityType: 'investment',
    entityId: investment.id,
    branchId: investment.branch_id,
    requestedBy: appliedBy,
    amountPesewas: principalPesewas,
  });

  const { rows: updatedRows } = await pool.query(
    "UPDATE investments SET status = 'pending_approval', updated_at = now() WHERE id = $1 RETURNING *",
    [investment.id]
  );

  return { investment: updatedRows[0], approvalRequest };
}

/**
 * Registered as the 'investment.book' execution handler — flips the
 * investment to `approved`. Activation (funding + GL posting) stays a
 * separate, explicitly-permissioned action, same reasoning as
 * loan.approve vs. loan.disburse: this handler runs inside decide()'s
 * transaction and must not call glPosting (which owns its own).
 *
 * NOTE: like Module 3's loan.approve, this handler only runs on
 * `decision === 'approved'` — the shared approvalWorkflow.decide() never
 * invokes execution handlers on rejection, so a rejected booking leaves
 * investments.status at 'pending_approval' (the approval_requests row
 * itself does correctly show 'rejected', just not mirrored onto
 * investments.status). Same pre-existing gap as loans — see Open
 * Questions rather than a silent behavioral difference between modules.
 */
async function applyInvestmentApprovalDecision(approvalRequest, db) {
  const investmentId = Number(approvalRequest.entity_id);
  const { rows: beforeRows } = await db.query('SELECT * FROM investments WHERE id = $1 FOR UPDATE', [investmentId]);
  const before = beforeRows[0];
  if (!before) throw new InvestmentNotFoundError(`investment ${investmentId} not found`);

  const { rows } = await db.query(
    "UPDATE investments SET status = 'approved', updated_at = now() WHERE id = $1 RETURNING *",
    [investmentId]
  );

  await auditLog.record(db, {
    userId: approvalRequest.decided_by,
    branchId: before.branch_id,
    action: 'investment.approved',
    entityType: 'investment',
    entityId: investmentId,
    beforeState: { status: before.status },
    afterState: { status: rows[0].status },
  });
}

/**
 * Activates an approved investment: sets start_date/maturity_date and
 * posts the funding GL entry (Dr Cash in Hand / Cr Investment Deposits
 * Payable). This is when the accrual clock actually starts.
 */
async function activateInvestment(pool, { investmentId, activatedBy, startDate = todayIso() }) {
  if (!activatedBy) throw new InvestmentValidationError('activatedBy is required');

  const investment = await getInvestment(pool, investmentId);
  if (investment.status !== 'approved') {
    throw new InvestmentConflictError(`investment ${investmentId} must be approved before activation (status: ${investment.status})`);
  }

  const { rows: approvalRows } = await pool.query(
    `SELECT id FROM approval_requests
      WHERE action_type = 'investment.book' AND entity_type = 'investment' AND entity_id = $1 AND status = 'approved'
      LIMIT 1`,
    [String(investmentId)]
  );
  if (approvalRows.length === 0) {
    throw new InvestmentConflictError(`investment ${investmentId} has no approved maker-checker approval on record`);
  }

  const maturityDate = investmentMath.computeMaturityDate(startDate, investment.tenor_months);
  const glAccounts = await getBranchGlAccounts(pool, investment.branch_id);
  const principalPesewas = Number(investment.principal_pesewas);

  const journalEntry = await glPosting.postJournalEntry(pool, {
    branchId: investment.branch_id,
    reference: `INV-${investmentId}-ACT`,
    description: `Activation of investment ${investmentId}`,
    entryDate: startDate,
    sourceModule: 'investment',
    createdBy: activatedBy,
    lines: [
      { accountId: glAccounts.cash_in_hand_account_id, debitPesewas: principalPesewas, branchId: investment.branch_id },
      { accountId: glAccounts.investment_deposits_payable_account_id, creditPesewas: principalPesewas, branchId: investment.branch_id },
    ],
  });

  const { rows } = await pool.query(
    `UPDATE investments
        SET status = 'active', start_date = $1, maturity_date = $2, activated_at = now(), activated_by = $3,
            booking_journal_entry_id = $4, updated_at = now()
      WHERE id = $5
      RETURNING *`,
    [startDate, maturityDate, activatedBy, journalEntry.id, investmentId]
  );

  await auditLog.record(pool, {
    userId: activatedBy,
    branchId: investment.branch_id,
    action: 'investment.activated',
    entityType: 'investment',
    entityId: investmentId,
    beforeState: { status: 'approved' },
    afterState: { status: 'active', startDate, maturityDate, journalEntryId: journalEntry.id },
  });

  return { ...rows[0], journalEntry };
}

// --- Interest accrual ----------------------------------------------------------

/** Total accrued so far, minus whatever has already been paid out — the current outstanding interest liability. */
async function getUnpaidAccruedInterestPesewas(db, investmentId) {
  const { rows } = await db.query(
    `SELECT
       COALESCE((SELECT SUM(interest_pesewas) FROM investment_accruals WHERE investment_id = $1), 0) AS accrued,
       COALESCE((SELECT SUM(amount_pesewas) FROM investment_payouts WHERE investment_id = $1 AND status = 'paid'), 0) AS paid`,
    [investmentId]
  );
  return Number(rows[0].accrued) - Number(rows[0].paid);
}

/**
 * Accrues interest on an active investment's principal for `days` and
 * posts it (Dr Investment Interest Expense / Cr Investment Deposits
 * Payable). Interest is computed on the ORIGINAL principal each time
 * (no compounding — see investmentMath.js). The GL entry is posted FIRST
 * (unlike loan_repayments/savings_transactions, there's no prior local
 * row that needs its own id before posting), then investment_accruals is
 * inserted with journal_entry_id already known — see migration comment.
 * A computed interest of 0 (e.g. a 0%-rate product) is a no-op, same
 * lesson learned from Module 3's overdraft interest accrual.
 */
async function accrueInterest(pool, { investmentId, accrualDate = todayIso(), days = 30, accruedBy }) {
  if (!accruedBy) throw new InvestmentValidationError('accruedBy is required');

  const investment = await getInvestment(pool, investmentId);
  if (investment.status !== 'active') {
    throw new InvestmentConflictError(`investment ${investmentId} is not active (status: ${investment.status})`);
  }

  const principalPesewas = Number(investment.principal_pesewas);
  const interestPesewas = investmentMath.computeAccrualPesewas({
    principalPesewas,
    annualInterestRateBps: investment.annual_interest_rate_bps,
    days,
  });
  if (interestPesewas <= 0) {
    return { investmentId: Number(investmentId), accrued: false, interestPesewas: 0 };
  }

  const { rows: existingRows } = await pool.query(
    'SELECT id FROM investment_accruals WHERE investment_id = $1 AND accrual_date = $2',
    [investmentId, accrualDate]
  );
  if (existingRows.length > 0) {
    throw new InvestmentConflictError(`investment ${investmentId} already accrued interest for ${accrualDate}`);
  }

  const glAccounts = await getBranchGlAccounts(pool, investment.branch_id);
  const journalEntry = await glPosting.postJournalEntry(pool, {
    branchId: investment.branch_id,
    reference: `INV-${investmentId}-ACR-${accrualDate}`,
    description: `Interest accrual on investment ${investmentId}`,
    entryDate: accrualDate,
    sourceModule: 'investment',
    createdBy: accruedBy,
    lines: [
      { accountId: glAccounts.investment_interest_expense_account_id, debitPesewas: interestPesewas, branchId: investment.branch_id },
      { accountId: glAccounts.investment_deposits_payable_account_id, creditPesewas: interestPesewas, branchId: investment.branch_id },
    ],
  });

  const { rows } = await pool.query(
    `INSERT INTO investment_accruals
       (investment_id, accrual_date, principal_balance_pesewas, interest_pesewas, journal_entry_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [investmentId, accrualDate, principalPesewas, interestPesewas, journalEntry.id, accruedBy]
  );

  await auditLog.record(pool, {
    userId: accruedBy,
    branchId: investment.branch_id,
    action: 'investment.interest_accrued',
    entityType: 'investment',
    entityId: investmentId,
    afterState: { accrualDate, interestPesewas, journalEntryId: journalEntry.id },
  });

  return { investmentId: Number(investmentId), accrued: true, ...rows[0], interestPesewas, journalEntry };
}

// --- Periodic interest payouts (threshold-gated) ------------------------------

async function resolvePayoutThreshold(db, product, branchId) {
  const thresholdRow = await approvalWorkflow.getApplicableThreshold(db, { actionType: 'investment.payout', branchId });
  if (thresholdRow) return Number(thresholdRow.amount_threshold_pesewas);
  return Number(product.payout_approval_threshold_pesewas);
}

/**
 * Requests a periodic interest payout. `amountPesewas` defaults to the
 * full unpaid-accrued-interest balance if omitted. Below the threshold it
 * pays out immediately; at or above it, queues for maker-checker approval
 * (same shape as Module 4's requestWithdrawal).
 */
async function requestInvestmentPayout(pool, { investmentId, amountPesewas = null, requestedBy }) {
  if (!requestedBy) throw new InvestmentValidationError('requestedBy is required');

  const investment = await getInvestment(pool, investmentId);
  if (investment.status !== 'active') {
    throw new InvestmentConflictError(`investment ${investmentId} is not active (status: ${investment.status})`);
  }

  const unpaidAccrued = await getUnpaidAccruedInterestPesewas(pool, investmentId);
  const amount = amountPesewas === null ? unpaidAccrued : Number(amountPesewas);
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new InvestmentValidationError('amountPesewas must be a positive integer');
  }
  if (amount > unpaidAccrued) {
    throw new InvestmentValidationError(
      `payout of ${amount} exceeds the unpaid accrued interest balance of ${unpaidAccrued} pesewas`
    );
  }

  const product = await getInvestmentProduct(pool, investment.product_id);
  const thresholdPesewas = await resolvePayoutThreshold(pool, product, investment.branch_id);
  const needsApproval = approvalWorkflow.isApprovalRequired({ amount_threshold_pesewas: thresholdPesewas }, amount);

  if (!needsApproval) {
    const { rows } = await pool.query(
      `INSERT INTO investment_payouts (investment_id, amount_pesewas, threshold_flag, status, requested_by)
       VALUES ($1, $2, false, 'pending', $3) RETURNING *`,
      [investmentId, amount, requestedBy]
    );
    return payOutInvestmentPayout(pool, { payoutRequest: rows[0], paidBy: requestedBy });
  }

  const approvalRequest = await approvalWorkflow.requestApproval(pool, {
    actionType: 'investment.payout',
    entityType: 'investment',
    entityId: investmentId,
    branchId: investment.branch_id,
    requestedBy,
    amountPesewas: amount,
  });

  const { rows } = await pool.query(
    `INSERT INTO investment_payouts (investment_id, amount_pesewas, threshold_flag, approval_request_id, status, requested_by)
     VALUES ($1, $2, true, $3, 'pending', $4) RETURNING *`,
    [investmentId, amount, approvalRequest.id, requestedBy]
  );

  return { payoutRequest: rows[0], approvalRequest, paidOut: false, thresholdPesewas };
}

/** Performs the actual payout movement for a periodic interest payout. */
async function payOutInvestmentPayout(pool, { payoutRequest, paidBy, paymentReference = null }) {
  const investment = await getInvestment(pool, payoutRequest.investment_id);
  const glAccounts = await getBranchGlAccounts(pool, investment.branch_id);
  const amountPesewas = Number(payoutRequest.amount_pesewas);

  const journalEntry = await glPosting.postJournalEntry(pool, {
    branchId: investment.branch_id,
    reference: `INV-${investment.id}-PYT-${payoutRequest.id}`,
    description: `Interest payout on investment ${investment.id}`,
    entryDate: todayIso(),
    sourceModule: 'investment',
    createdBy: paidBy,
    lines: [
      { accountId: glAccounts.investment_deposits_payable_account_id, debitPesewas: amountPesewas, branchId: investment.branch_id },
      { accountId: glAccounts.cash_in_hand_account_id, creditPesewas: amountPesewas, branchId: investment.branch_id },
    ],
  });

  const { rows } = await pool.query(
    `UPDATE investment_payouts
        SET status = 'paid', journal_entry_id = $1, payment_reference = $2, updated_at = now()
      WHERE id = $3
      RETURNING *`,
    [journalEntry.id, paymentReference, payoutRequest.id]
  );

  await auditLog.record(pool, {
    userId: paidBy,
    branchId: investment.branch_id,
    action: 'investment.payout_paid',
    entityType: 'investment',
    entityId: investment.id,
    afterState: { amountPesewas, journalEntryId: journalEntry.id },
  });

  return { payoutRequest: rows[0], paidOut: true, journalEntry };
}

/**
 * Registered as the 'investment.payout' execution handler. Mirrors
 * savingsService.payOutWithdrawalOnApproval exactly: only records the
 * approval outcome inside decide()'s transaction — the actual payout
 * (glPosting owns its own transaction) happens afterward via
 * settleApprovedInvestmentPayout.
 */
async function payOutInvestmentPayoutOnApproval(approvalRequest, db) {
  const { rows } = await db.query('SELECT * FROM investment_payouts WHERE approval_request_id = $1', [approvalRequest.id]);
  const payoutRequest = rows[0];
  if (!payoutRequest) throw new InvestmentNotFoundError(`no investment_payouts row for approval_request ${approvalRequest.id}`);

  await auditLog.record(db, {
    userId: approvalRequest.decided_by,
    branchId: approvalRequest.branch_id,
    action: 'investment.payout_approved',
    entityType: 'investment_payout',
    entityId: payoutRequest.id,
    afterState: { approvalRequestId: approvalRequest.id },
  });
}

async function settleApprovedInvestmentPayout(pool, { payoutId, paidBy, paymentReference }) {
  const { rows } = await pool.query(
    `SELECT ip.*, ar.status AS approval_status FROM investment_payouts ip
       LEFT JOIN approval_requests ar ON ar.id = ip.approval_request_id
      WHERE ip.id = $1`,
    [payoutId]
  );
  const payoutRequest = rows[0];
  if (!payoutRequest) throw new InvestmentNotFoundError(`investment_payout ${payoutId} not found`);
  if (payoutRequest.status === 'paid') throw new InvestmentConflictError(`investment_payout ${payoutId} is already paid`);
  if (payoutRequest.threshold_flag && payoutRequest.approval_status !== 'approved') {
    throw new InvestmentConflictError(
      `investment_payout ${payoutId} is not approved (approval status: ${payoutRequest.approval_status})`
    );
  }
  return payOutInvestmentPayout(pool, { payoutRequest, paidBy, paymentReference });
}

// --- Redemption (disinvestment) — ALWAYS maker-checker ------------------------

/**
 * Requests a redemption (early or at maturity) — ALWAYS goes through
 * maker-checker, no threshold escape hatch (the module spec's explicit
 * "pending-approval queue for ... disinvestments"). Snapshots the payout
 * math (principal + accrued interest, less any early-withdrawal penalty)
 * at request time so what gets paid never silently drifts from what was
 * approved.
 */
async function requestRedemption(pool, { investmentId, redemptionDate = todayIso(), requestedBy }) {
  if (!requestedBy) throw new InvestmentValidationError('requestedBy is required');

  const investment = await getInvestment(pool, investmentId);
  if (investment.status !== 'active') {
    throw new InvestmentConflictError(`investment ${investmentId} is not active (status: ${investment.status})`);
  }

  const { rows: existingRows } = await pool.query('SELECT id FROM investment_redemptions WHERE investment_id = $1', [
    investmentId,
  ]);
  if (existingRows.length > 0) {
    throw new InvestmentConflictError(`investment ${investmentId} already has a redemption on record`);
  }

  const accruedInterestPesewas = await getUnpaidAccruedInterestPesewas(pool, investmentId);
  const isEarly = investmentMath.isEarlyRedemption(redemptionDate, toDateString(investment.maturity_date));
  const { penaltyPesewas, interestPayablePesewas, totalPayoutPesewas } = investmentMath.computeRedemptionPesewas({
    principalPesewas: Number(investment.principal_pesewas),
    accruedInterestPesewas,
    isEarly,
    penaltyRateBps: investment.early_withdrawal_penalty_bps,
  });

  const approvalRequest = await approvalWorkflow.requestApproval(pool, {
    actionType: 'investment.redeem',
    entityType: 'investment',
    entityId: investmentId,
    branchId: investment.branch_id,
    requestedBy,
    amountPesewas: totalPayoutPesewas,
    payload: { isEarly, redemptionDate },
  });

  const { rows } = await pool.query(
    `INSERT INTO investment_redemptions
       (investment_id, is_early, principal_pesewas, accrued_interest_pesewas, penalty_pesewas, interest_payable_pesewas,
        total_payout_pesewas, approval_request_id, status, requested_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9)
     RETURNING *`,
    [
      investmentId,
      isEarly,
      Number(investment.principal_pesewas),
      accruedInterestPesewas,
      penaltyPesewas,
      interestPayablePesewas,
      totalPayoutPesewas,
      approvalRequest.id,
      requestedBy,
    ]
  );

  return { redemption: rows[0], approvalRequest };
}

/**
 * Registered as the 'investment.redeem' execution handler. Same
 * two-phase reasoning as payouts: only flips investment_redemptions to
 * `approved` here; the actual payout GL posting happens in
 * `confirmRedemptionPayout`, a separate explicit call.
 */
async function applyRedemptionApprovalDecision(approvalRequest, db) {
  const { rows: redemptionRows } = await db.query(
    'SELECT * FROM investment_redemptions WHERE approval_request_id = $1 FOR UPDATE',
    [approvalRequest.id]
  );
  const redemption = redemptionRows[0];
  if (!redemption) throw new InvestmentNotFoundError(`no investment_redemptions row for approval_request ${approvalRequest.id}`);

  const { rows } = await db.query(
    "UPDATE investment_redemptions SET status = 'approved', updated_at = now() WHERE id = $1 RETURNING *",
    [redemption.id]
  );

  await auditLog.record(db, {
    userId: approvalRequest.decided_by,
    branchId: approvalRequest.branch_id,
    action: 'investment.redemption_approved',
    entityType: 'investment_redemption',
    entityId: redemption.id,
    beforeState: { status: redemption.status },
    afterState: { status: rows[0].status },
  });
}

/**
 * Confirms an approved redemption's payout — never marks it paid
 * optimistically (see Decisions_Log.md's "BEFORE YOU WRITE CODE"
 * resolution). Extinguishes the FULL liability (principal + accrued
 * interest) and posts the penalty (if any) to income.
 */
async function confirmRedemptionPayout(pool, { redemptionId, paymentReference = null, confirmedBy }) {
  if (!confirmedBy) throw new InvestmentValidationError('confirmedBy is required');

  const { rows: redemptionRows } = await pool.query('SELECT * FROM investment_redemptions WHERE id = $1', [redemptionId]);
  const redemption = redemptionRows[0];
  if (!redemption) throw new InvestmentNotFoundError(`investment_redemption ${redemptionId} not found`);
  if (redemption.status !== 'approved') {
    throw new InvestmentConflictError(`investment_redemption ${redemptionId} is not approved (status: ${redemption.status})`);
  }

  const investment = await getInvestment(pool, redemption.investment_id);
  const glAccounts = await getBranchGlAccounts(pool, investment.branch_id);

  const principalPesewas = Number(redemption.principal_pesewas);
  const accruedInterestPesewas = Number(redemption.accrued_interest_pesewas);
  const penaltyPesewas = Number(redemption.penalty_pesewas);
  const totalPayoutPesewas = Number(redemption.total_payout_pesewas);

  const lines = [
    {
      accountId: glAccounts.investment_deposits_payable_account_id,
      debitPesewas: principalPesewas + accruedInterestPesewas,
      branchId: investment.branch_id,
    },
    { accountId: glAccounts.cash_in_hand_account_id, creditPesewas: totalPayoutPesewas, branchId: investment.branch_id },
  ];
  if (penaltyPesewas > 0) {
    lines.push({
      accountId: glAccounts.early_withdrawal_penalty_income_account_id,
      creditPesewas: penaltyPesewas,
      branchId: investment.branch_id,
    });
  }

  const journalEntry = await glPosting.postJournalEntry(pool, {
    branchId: investment.branch_id,
    reference: `INV-${investment.id}-RDM`,
    description: `Redemption of investment ${investment.id}`,
    entryDate: todayIso(),
    sourceModule: 'investment',
    createdBy: confirmedBy,
    lines,
  });

  const { rows } = await pool.query(
    `UPDATE investment_redemptions
        SET status = 'paid', journal_entry_id = $1, payment_reference = $2, updated_at = now()
      WHERE id = $3
      RETURNING *`,
    [journalEntry.id, paymentReference, redemptionId]
  );

  const { rows: investmentRows } = await pool.query(
    `UPDATE investments SET status = 'redeemed', redeemed_at = now(), redeemed_by = $1, updated_at = now() WHERE id = $2 RETURNING *`,
    [confirmedBy, investment.id]
  );

  await auditLog.record(pool, {
    userId: confirmedBy,
    branchId: investment.branch_id,
    action: 'investment.redeemed',
    entityType: 'investment',
    entityId: investment.id,
    beforeState: { status: 'active' },
    afterState: { status: 'redeemed', totalPayoutPesewas, penaltyPesewas, journalEntryId: journalEntry.id },
  });

  return { redemption: rows[0], investment: investmentRows[0], journalEntry };
}

// --- Investor statement -------------------------------------------------------

async function getInvestorStatement(pool, { investmentId }) {
  const investment = await getInvestment(pool, investmentId);
  const { rows: accruals } = await pool.query(
    'SELECT * FROM investment_accruals WHERE investment_id = $1 ORDER BY accrual_date',
    [investmentId]
  );
  const { rows: payouts } = await pool.query(
    'SELECT * FROM investment_payouts WHERE investment_id = $1 ORDER BY created_at',
    [investmentId]
  );
  const { rows: redemptionRows } = await pool.query('SELECT * FROM investment_redemptions WHERE investment_id = $1', [
    investmentId,
  ]);

  const totalAccruedPesewas = accruals.reduce((s, a) => s + Number(a.interest_pesewas), 0);
  const totalPaidOutPesewas = payouts
    .filter((p) => p.status === 'paid')
    .reduce((s, p) => s + Number(p.amount_pesewas), 0);

  return {
    investment,
    accruals,
    payouts,
    redemption: redemptionRows[0] || null,
    totalAccruedPesewas,
    totalPaidOutPesewas,
    outstandingInterestLiabilityPesewas: totalAccruedPesewas - totalPaidOutPesewas,
  };
}

/** Call once at app startup so decide() can dispatch investment approvals. */
function registerInvestmentExecutionHandlers() {
  approvalWorkflow.registerExecutionHandler('investment.book', applyInvestmentApprovalDecision);
  approvalWorkflow.registerExecutionHandler('investment.payout', payOutInvestmentPayoutOnApproval);
  approvalWorkflow.registerExecutionHandler('investment.redeem', applyRedemptionApprovalDecision);
}

module.exports = {
  createInvestmentProduct,
  getInvestmentProduct,
  listInvestmentProducts,
  getInvestment,
  listInvestments,
  bookInvestment,
  applyInvestmentApprovalDecision,
  activateInvestment,
  getUnpaidAccruedInterestPesewas,
  accrueInterest,
  requestInvestmentPayout,
  payOutInvestmentPayout,
  payOutInvestmentPayoutOnApproval,
  settleApprovedInvestmentPayout,
  requestRedemption,
  applyRedemptionApprovalDecision,
  confirmRedemptionPayout,
  getInvestorStatement,
  getBranchGlAccounts,
  registerInvestmentExecutionHandlers,
  InvestmentValidationError,
  InvestmentNotFoundError,
  InvestmentConflictError,
};
