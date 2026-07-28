'use strict';

const auditLog = require('../../shared/auditLog');
const approvalWorkflow = require('../../shared/approvalWorkflow');
const glPosting = require('../../shared/glPosting');
const loanMath = require('./loanMath');
const policyRateService = require('./policyRateService');
const savingsService = require('../savings/savingsService');
const calendarMath = require('../systemAdmin/calendarMath');
const calendarService = require('../systemAdmin/calendarService');

/**
 * Module 3: Loan Management. Uses the Module 11/7 shared services
 * (auditLog, approvalWorkflow, glPosting) exactly as documented in
 * Decisions_Log.md — loan approval and restructuring are maker-checker
 * gated via approvalWorkflow.registerExecutionHandler, the same pattern
 * Modules 1 and 2 use for branch/customer closure. All interest and
 * allocation math lives in the pure, separately-tested ./loanMath.js.
 */

class LoanValidationError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 400;
  }
}
class LoanNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 404;
  }
}
class LoanConflictError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 409;
  }
}

const todayIso = () => new Date().toISOString().slice(0, 10);

// --- Loan products ---------------------------------------------------------

const REPAYMENT_FREQUENCIES_SUPPORTED = ['monthly'];

/**
 * Validates+resolves the fixed/floating rate fields shared by
 * createLoanProduct and updateLoanProduct. Returns the effective
 * annual_interest_rate_bps to store: the admin's own input for a FIXED
 * product, or reference_rate.rate_bps + spread_bps (computed here, not
 * accepted as freeform input) for a FLOATING one — see migration 054's
 * comment for why annual_interest_rate_bps stays the single column every
 * consumer already reads regardless of rate_type.
 */
async function resolveRateFields(pool, { rateType, annualInterestRateBps, referenceRateId, spreadBps, resetFrequency }) {
  if (rateType !== 'fixed' && rateType !== 'floating') {
    throw new LoanValidationError("rateType must be 'fixed' or 'floating'");
  }
  if (rateType === 'fixed') {
    if (!Number.isInteger(annualInterestRateBps) || annualInterestRateBps < 0) {
      throw new LoanValidationError('annualInterestRateBps must be a non-negative integer for a fixed-rate product');
    }
    return { effectiveAnnualInterestRateBps: annualInterestRateBps, referenceRateId: null, spreadBps: null, resetFrequency: null };
  }
  if (!referenceRateId || !Number.isInteger(spreadBps) || spreadBps < 0 || !resetFrequency) {
    throw new LoanValidationError('referenceRateId, a non-negative integer spreadBps, and resetFrequency are required for a floating-rate product');
  }
  if (!['monthly', 'quarterly', 'annually'].includes(resetFrequency)) {
    throw new LoanValidationError("resetFrequency must be 'monthly', 'quarterly', or 'annually'");
  }
  const referenceRate = await policyRateService.getPolicyRate(pool, referenceRateId);
  const effectiveAnnualInterestRateBps = loanMath.computeFloatingEffectiveRateBps({
    referenceRateBps: referenceRate.rate_bps,
    spreadBps,
  });
  return { effectiveAnnualInterestRateBps, referenceRateId, spreadBps, resetFrequency };
}

function assertAllowedRepaymentFrequencies(allowedRepaymentFrequencies) {
  const unsupported = allowedRepaymentFrequencies.filter((f) => !REPAYMENT_FREQUENCIES_SUPPORTED.includes(f));
  if (unsupported.length > 0) {
    // Deliberate scope boundary, not a bug: loanMath.js's schedule
    // generator amortizes MONTHLY only (see its module comment). This
    // field records real product intent without silently implying a
    // repayment cadence this codebase doesn't actually amortize — see
    // Decisions_Log.md.
    throw new LoanValidationError(
      `allowedRepaymentFrequencies only supports ${REPAYMENT_FREQUENCIES_SUPPORTED.join(', ')} today (got: ${unsupported.join(', ')}) — the loan schedule generator does not yet amortize on any other cadence`
    );
  }
}

async function createLoanProduct(pool, params) {
  const {
    name,
    code,
    description = null,
    loanType,
    interestMethod,
    rateType = 'fixed',
    annualInterestRateBps,
    referenceRateId = null,
    spreadBps = null,
    resetFrequency = null,
    minRateFloorBps = null,
    minSpreadFloorBps = null,
    concessionApprovalThresholdBps = 0,
    allowedRepaymentFrequencies = ['monthly'],
    minTermMonths,
    maxTermMonths,
    minPrincipalPesewas,
    maxPrincipalPesewas,
    feeSchedule = [],
    parBucketDays = [30, 60, 90],
    reasonCodes = [],
    createdBy,
  } = params;

  if (!name || !code || !loanType || !interestMethod || !createdBy) {
    throw new LoanValidationError('name, code, loanType, interestMethod, and createdBy are required');
  }
  assertAllowedRepaymentFrequencies(allowedRepaymentFrequencies);
  const rate = await resolveRateFields(pool, { rateType, annualInterestRateBps, referenceRateId, spreadBps, resetFrequency });

  // Validate the fee schedule shape up front rather than discovering a bad
  // fee config at disbursement time, when money is moving.
  loanMath.computeFeesPesewas(feeSchedule, 100000);

  const { rows } = await pool.query(
    `INSERT INTO loan_products
       (name, code, description, loan_type, interest_method, annual_interest_rate_bps, rate_type, reference_rate_id,
        spread_bps, reset_frequency, min_rate_floor_bps, min_spread_floor_bps, concession_approval_threshold_bps,
        allowed_repayment_frequencies, min_term_months, max_term_months, min_principal_pesewas, max_principal_pesewas,
        fee_schedule, par_bucket_days, reason_codes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
     RETURNING *`,
    [
      name,
      String(code).toUpperCase(),
      description,
      loanType,
      interestMethod,
      rate.effectiveAnnualInterestRateBps,
      rateType,
      rate.referenceRateId,
      rate.spreadBps,
      rate.resetFrequency,
      minRateFloorBps,
      minSpreadFloorBps,
      concessionApprovalThresholdBps,
      allowedRepaymentFrequencies,
      minTermMonths,
      maxTermMonths,
      minPrincipalPesewas,
      maxPrincipalPesewas,
      JSON.stringify(feeSchedule),
      parBucketDays,
      reasonCodes,
      createdBy,
    ]
  );
  return rows[0];
}

async function getLoanProduct(pool, productId) {
  const { rows } = await pool.query('SELECT * FROM loan_products WHERE id = $1', [productId]);
  if (!rows[0]) throw new LoanNotFoundError(`loan_product ${productId} not found`);
  return rows[0];
}

async function listLoanProducts(pool, { loanType, status } = {}) {
  const clauses = [];
  const params = [];
  if (loanType) {
    params.push(loanType);
    clauses.push(`loan_type = $${params.length}`);
  }
  if (status) {
    params.push(status);
    clauses.push(`status = $${params.length}`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await pool.query(`SELECT * FROM loan_products ${where} ORDER BY code`, params);
  return rows;
}

/**
 * Edits a product's configuration. Safe to change ANY field, including
 * rate/fees/limits, without retroactively touching a loan already
 * applied for — every loan snapshots interest_method,
 * annual_interest_rate_bps, term_months, and (since migration 055)
 * fee_schedule onto its own row at application time, so an edit here
 * only ever changes what a FUTURE application sees. That's what makes
 * this a plain UPDATE rather than a new-version-per-edit table like
 * complianceService's report templates: the "past disbursements don't
 * silently change" guarantee already lives at the loan row, not the
 * product row. Every change is still audited (see auditLog.record
 * below) for exactly the same reason regulatory review needs it
 * anywhere else in this codebase.
 */
async function updateLoanProduct(pool, { productId, updatedBy, actorBranchId, ...fields }) {
  if (!updatedBy || !actorBranchId) {
    throw new LoanValidationError('updatedBy and actorBranchId are required');
  }
  const before = await getLoanProduct(pool, productId);

  const merged = {
    name: fields.name ?? before.name,
    description: fields.description !== undefined ? fields.description : before.description,
    status: fields.status ?? before.status,
    interestMethod: fields.interestMethod ?? before.interest_method,
    rateType: fields.rateType ?? before.rate_type,
    annualInterestRateBps: fields.annualInterestRateBps ?? before.annual_interest_rate_bps,
    referenceRateId: fields.referenceRateId !== undefined ? fields.referenceRateId : before.reference_rate_id,
    spreadBps: fields.spreadBps !== undefined ? fields.spreadBps : before.spread_bps,
    resetFrequency: fields.resetFrequency !== undefined ? fields.resetFrequency : before.reset_frequency,
    minRateFloorBps: fields.minRateFloorBps !== undefined ? fields.minRateFloorBps : before.min_rate_floor_bps,
    minSpreadFloorBps: fields.minSpreadFloorBps !== undefined ? fields.minSpreadFloorBps : before.min_spread_floor_bps,
    concessionApprovalThresholdBps: fields.concessionApprovalThresholdBps ?? before.concession_approval_threshold_bps,
    allowedRepaymentFrequencies: fields.allowedRepaymentFrequencies ?? before.allowed_repayment_frequencies,
    minTermMonths: fields.minTermMonths ?? before.min_term_months,
    maxTermMonths: fields.maxTermMonths ?? before.max_term_months,
    minPrincipalPesewas: fields.minPrincipalPesewas ?? before.min_principal_pesewas,
    maxPrincipalPesewas: fields.maxPrincipalPesewas ?? before.max_principal_pesewas,
    feeSchedule: fields.feeSchedule ?? before.fee_schedule,
    parBucketDays: fields.parBucketDays ?? before.par_bucket_days,
    reasonCodes: fields.reasonCodes ?? before.reason_codes,
  };

  if (!['active', 'inactive'].includes(merged.status)) {
    throw new LoanValidationError("status must be 'active' or 'inactive'");
  }
  assertAllowedRepaymentFrequencies(merged.allowedRepaymentFrequencies);
  const rate = await resolveRateFields(pool, {
    rateType: merged.rateType,
    annualInterestRateBps: merged.annualInterestRateBps,
    referenceRateId: merged.referenceRateId,
    spreadBps: merged.spreadBps,
    resetFrequency: merged.resetFrequency,
  });
  loanMath.computeFeesPesewas(merged.feeSchedule, 100000);

  const { rows } = await pool.query(
    `UPDATE loan_products SET
       name = $1, description = $2, status = $3, interest_method = $4, annual_interest_rate_bps = $5,
       rate_type = $6, reference_rate_id = $7, spread_bps = $8, reset_frequency = $9,
       min_rate_floor_bps = $10, min_spread_floor_bps = $11, concession_approval_threshold_bps = $12,
       allowed_repayment_frequencies = $13, min_term_months = $14, max_term_months = $15,
       min_principal_pesewas = $16, max_principal_pesewas = $17, fee_schedule = $18,
       par_bucket_days = $19, reason_codes = $20, updated_at = now()
     WHERE id = $21
     RETURNING *`,
    [
      merged.name,
      merged.description,
      merged.status,
      merged.interestMethod,
      rate.effectiveAnnualInterestRateBps,
      merged.rateType,
      rate.referenceRateId,
      rate.spreadBps,
      rate.resetFrequency,
      merged.minRateFloorBps,
      merged.minSpreadFloorBps,
      merged.concessionApprovalThresholdBps,
      merged.allowedRepaymentFrequencies,
      merged.minTermMonths,
      merged.maxTermMonths,
      merged.minPrincipalPesewas,
      merged.maxPrincipalPesewas,
      JSON.stringify(merged.feeSchedule),
      merged.parBucketDays,
      merged.reasonCodes,
      productId,
    ]
  );
  const after = rows[0];

  await auditLog.record(pool, {
    userId: updatedBy,
    branchId: actorBranchId,
    action: 'loan.product_updated',
    entityType: 'loan_product',
    entityId: productId,
    beforeState: before,
    afterState: after,
  });

  return after;
}

/**
 * Loan calculator — pure preview, creates nothing. Usable by staff
 * pre-appraisal and by customer-facing self-service (no commitment).
 */
async function calculateLoan(pool, { productId, principalPesewas, termMonths, startDate = todayIso() }) {
  const product = await getLoanProduct(pool, productId);
  assertWithinProductLimits(product, principalPesewas, termMonths);

  const schedule = loanMath.generateLoanSchedule({
    principalPesewas,
    termMonths,
    annualInterestRateBps: product.annual_interest_rate_bps,
    interestMethod: product.interest_method,
    startDate,
  });
  const feesPesewas = loanMath.computeFeesPesewas(product.fee_schedule, principalPesewas);
  const totalInterestPesewas = schedule.reduce((s, r) => s + r.interestDuePesewas, 0);

  return {
    productId: product.id,
    principalPesewas,
    termMonths,
    interestMethod: product.interest_method,
    annualInterestRateBps: product.annual_interest_rate_bps,
    feesPesewas,
    netDisbursedPesewas: principalPesewas - feesPesewas,
    totalInterestPesewas,
    totalRepayablePesewas: principalPesewas + totalInterestPesewas,
    schedule,
  };
}

function assertWithinProductLimits(product, principalPesewas, termMonths) {
  if (!Number.isInteger(principalPesewas) || principalPesewas <= 0) {
    throw new LoanValidationError('principalPesewas must be a positive integer');
  }
  if (!Number.isInteger(termMonths) || termMonths <= 0) {
    throw new LoanValidationError('termMonths must be a positive integer');
  }
  if (principalPesewas < Number(product.min_principal_pesewas) || principalPesewas > Number(product.max_principal_pesewas)) {
    throw new LoanValidationError(
      `principalPesewas ${principalPesewas} is outside product limits (${product.min_principal_pesewas}-${product.max_principal_pesewas})`
    );
  }
  if (termMonths < product.min_term_months || termMonths > product.max_term_months) {
    throw new LoanValidationError(
      `termMonths ${termMonths} is outside product limits (${product.min_term_months}-${product.max_term_months})`
    );
  }
}

const RESET_PERIOD_MONTHS = { monthly: 1, quarterly: 3, annually: 12 };

/**
 * Recomputes each due FLOATING product's LISTING rate
 * (reference_rate.rate_bps + spread_bps) — i.e. what a NEW application
 * inherits going forward. Deliberately does NOT retroactively re-price
 * already-disbursed loans under that product: a loan's rate is
 * snapshotted once at application (same guarantee fixed-rate loans have,
 * see migration 023's comment), so an outstanding floating loan's own
 * rate/schedule never moves after disbursement in this pass. Actually
 * re-pricing live loans mid-term — which is what "floating" ultimately
 * implies in a fuller build — is a materially bigger, money-moving
 * decision (it changes what a customer owes going forward) that wasn't
 * confirmed as in scope; flagged in Decisions_Log.md rather than built
 * silently.
 *
 * A product is "due" if it's never been reset, or if asOfDate has
 * crossed its reset_frequency boundary since last_reset_at. This is the
 * thin wrapper Module 12's job registry calls
 * (systemAdminService.runLoanFloatingRateResetJob) — see that module's
 * own "every job is a thin wrapper" rule.
 */
async function resetFloatingRateProducts(pool, { asOfDate = todayIso(), resetBy, actorBranchId }) {
  if (!resetBy || !actorBranchId) {
    throw new LoanValidationError('resetBy and actorBranchId are required');
  }

  const { rows: floatingProducts } = await pool.query(
    `SELECT * FROM loan_products WHERE rate_type = 'floating' AND status = 'active'`
  );

  const results = [];
  for (const product of floatingProducts) {
    try {
      const nextDueDate = product.last_reset_at
        ? loanMath.addMonthsToDateString(
            product.last_reset_at instanceof Date ? product.last_reset_at.toISOString().slice(0, 10) : product.last_reset_at,
            RESET_PERIOD_MONTHS[product.reset_frequency]
          )
        : asOfDate;
      if (asOfDate < nextDueDate) {
        continue; // not due yet
      }

      const referenceRate = await policyRateService.getPolicyRate(pool, product.reference_rate_id);
      const newRateBps = loanMath.computeFloatingEffectiveRateBps({
        referenceRateBps: referenceRate.rate_bps,
        spreadBps: product.spread_bps,
      });

      await pool.query(
        `UPDATE loan_products SET annual_interest_rate_bps = $1, last_reset_at = $2, updated_at = now() WHERE id = $3`,
        [newRateBps, asOfDate, product.id]
      );

      if (newRateBps !== product.annual_interest_rate_bps) {
        await auditLog.record(pool, {
          userId: resetBy,
          branchId: actorBranchId,
          action: 'loan.product_rate_reset',
          entityType: 'loan_product',
          entityId: product.id,
          beforeState: { annualInterestRateBps: product.annual_interest_rate_bps },
          afterState: { annualInterestRateBps: newRateBps, resetDate: asOfDate },
        });
      }

      results.push({ productId: Number(product.id), ok: true, oldRateBps: product.annual_interest_rate_bps, newRateBps });
    } catch (err) {
      results.push({ productId: Number(product.id), ok: false, error: err.message });
    }
  }

  return { processedCount: results.length, changedCount: results.filter((r) => r.ok && r.newRateBps !== r.oldRateBps).length, results };
}

// --- Loan application ------------------------------------------------------

async function getLoan(pool, loanId) {
  const { rows } = await pool.query('SELECT * FROM loans WHERE id = $1', [loanId]);
  if (!rows[0]) throw new LoanNotFoundError(`loan ${loanId} not found`);
  return rows[0];
}

async function listLoans(pool, { branchId, customerId, status, productId } = {}) {
  const clauses = [];
  const params = [];
  const addFilter = (column, value) => {
    if (value === undefined || value === null) return;
    params.push(value);
    clauses.push(`${column} = $${params.length}`);
  };
  addFilter('branch_id', branchId);
  addFilter('customer_id', customerId);
  addFilter('status', status);
  addFilter('product_id', productId);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await pool.query(`SELECT * FROM loans ${where} ORDER BY created_at DESC`, params);
  return rows;
}

/**
 * Group lending rule (module spec: "Group loans need a rule for how one
 * member's default affects the group's ability to access further group
 * credit"). DECIDED RULE: if any current member of the group has a
 * written-off loan, or is jointly liable on a written-off group loan, the
 * group cannot take out new group credit until that is resolved. Returns
 * the blocking members rather than a bare boolean so the caller can
 * report *who*. See Decisions_Log.md.
 */
async function findGroupCreditBlockers(db, groupCustomerId) {
  const { rows } = await db.query(
    `SELECT DISTINCT c.id AS customer_id, c.full_name, l.id AS loan_id
       FROM groups g
       JOIN group_members gm ON gm.group_id = g.id AND gm.left_at IS NULL
       JOIN customers c ON c.id = gm.customer_id
       JOIN loans l
         ON l.status = 'written_off'
        AND (
          l.customer_id = c.id
          OR l.id IN (SELECT lgl.loan_id FROM loan_group_liabilities lgl WHERE lgl.customer_id = c.id)
        )
      WHERE g.customer_id = $1`,
    [groupCustomerId]
  );
  return rows;
}

async function applyForLoan(pool, params) {
  const {
    customerId,
    productId,
    principalPesewas,
    termMonths,
    reasonCode = null,
    purposeNotes = null,
    overdraftSavingsAccountId = null,
    appliedBy,
  } = params;
  if (!customerId || !productId || !appliedBy) {
    throw new LoanValidationError('customerId, productId, and appliedBy are required');
  }

  const product = await getLoanProduct(pool, productId);
  if (product.status !== 'active') {
    throw new LoanConflictError(`loan_product ${productId} is not active`);
  }
  assertWithinProductLimits(product, principalPesewas, termMonths);

  if (product.reason_codes.length > 0 && reasonCode && !product.reason_codes.includes(reasonCode)) {
    throw new LoanValidationError(`reasonCode '${reasonCode}' is not allowed by product ${product.code}`);
  }

  const { rows: customerRows } = await pool.query('SELECT * FROM customers WHERE id = $1', [customerId]);
  const customer = customerRows[0];
  if (!customer) throw new LoanValidationError(`customer ${customerId} not found`);
  if (customer.status !== 'active') {
    throw new LoanConflictError(`customer ${customerId} is not active (status: ${customer.status})`);
  }
  if (customer.kyc_status !== 'verified') {
    throw new LoanConflictError(`customer ${customerId} must be KYC-verified before borrowing`);
  }

  // A group product must be taken by a group customer, and vice versa —
  // otherwise joint-liability snapshotting at disbursement has nothing to
  // snapshot.
  if (product.loan_type === 'group' && customer.customer_type !== 'group') {
    throw new LoanValidationError(`product ${product.code} is a group product; customer ${customerId} is not a group`);
  }
  if (product.loan_type !== 'group' && customer.customer_type === 'group') {
    throw new LoanValidationError(`customer ${customerId} is a group; use a group loan product`);
  }

  if (customer.customer_type === 'group') {
    const blockers = await findGroupCreditBlockers(pool, customerId);
    if (blockers.length > 0) {
      throw new LoanConflictError(
        `group has member(s) with written-off loans, blocking new group credit: ${blockers
          .map((b) => `${b.full_name} (loan ${b.loan_id})`)
          .join(', ')}`
      );
    }
  }

  // An overdraft loan is a revolving facility against a specific EXISTING
  // savings account, not a standalone principal handed over — see
  // Decisions_Log.md. principalPesewas is repurposed to mean "the
  // requested/approved LIMIT" for this loan_type.
  if (product.loan_type === 'overdraft') {
    if (!overdraftSavingsAccountId) {
      throw new LoanValidationError('overdraftSavingsAccountId is required for an overdraft loan application');
    }
    const account = await savingsService.getAccount(pool, overdraftSavingsAccountId);
    if (Number(account.customer_id) !== Number(customerId)) {
      throw new LoanValidationError(`savings_account ${overdraftSavingsAccountId} does not belong to customer ${customerId}`);
    }
    if (account.status !== 'active') {
      throw new LoanConflictError(`savings_account ${overdraftSavingsAccountId} is not active (status: ${account.status})`);
    }
    const { product: savingsProduct } = await savingsService.getChargesConfigForAccount(pool, account);
    if (!savingsProduct.allows_overdraft) {
      throw new LoanConflictError(`savings_account ${overdraftSavingsAccountId}'s product does not allow overdraft`);
    }
    const { rows: existingRows } = await pool.query(
      `SELECT id FROM loans
        WHERE overdraft_savings_account_id = $1
          AND status NOT IN ('rejected', 'closed', 'written_off')`,
      [overdraftSavingsAccountId]
    );
    if (existingRows.length > 0) {
      throw new LoanConflictError(
        `savings_account ${overdraftSavingsAccountId} already has an active overdraft facility (loan ${existingRows[0].id})`
      );
    }
  } else if (overdraftSavingsAccountId) {
    throw new LoanValidationError(`overdraftSavingsAccountId is only applicable to overdraft loans`);
  }

  const { rows } = await pool.query(
    `INSERT INTO loans
       (loan_type, customer_id, branch_id, product_id, principal_pesewas, term_months,
        interest_method, annual_interest_rate_bps, fee_schedule, reason_code, purpose_notes,
        overdraft_savings_account_id, applied_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING *`,
    [
      product.loan_type,
      customerId,
      customer.branch_id,
      productId,
      principalPesewas,
      termMonths,
      product.interest_method,
      product.annual_interest_rate_bps,
      // Snapshotted here (not read live at disbursement) for the same
      // reason interest_method/annual_interest_rate_bps already are —
      // see migration 055_loans_fee_schedule_snapshot.sql.
      JSON.stringify(product.fee_schedule),
      reasonCode,
      purposeNotes,
      overdraftSavingsAccountId,
      appliedBy,
    ]
  );
  const loan = rows[0];

  await auditLog.record(pool, {
    userId: appliedBy,
    branchId: loan.branch_id,
    action: 'loan.applied',
    entityType: 'loan',
    entityId: loan.id,
    afterState: loan,
  });

  return loan;
}

// --- Appraisal -------------------------------------------------------------

async function submitAppraisal(pool, { loanId, checklist, recommendation, notes = null, appraiserId }) {
  if (!checklist || !recommendation || !appraiserId) {
    throw new LoanValidationError('checklist, recommendation, and appraiserId are required');
  }
  if (recommendation !== 'recommend' && recommendation !== 'decline') {
    throw new LoanValidationError("recommendation must be 'recommend' or 'decline'");
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: loanRows } = await client.query('SELECT * FROM loans WHERE id = $1 FOR UPDATE', [loanId]);
    const loan = loanRows[0];
    if (!loan) throw new LoanNotFoundError(`loan ${loanId} not found`);
    if (loan.status !== 'applied' && loan.status !== 'appraised') {
      throw new LoanConflictError(`loan ${loanId} cannot be appraised in status '${loan.status}'`);
    }

    const { rows: appraisalRows } = await client.query(
      `INSERT INTO loan_appraisals (loan_id, appraiser_id, checklist, recommendation, notes)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [loanId, appraiserId, JSON.stringify(checklist), recommendation, notes]
    );

    const newStatus = recommendation === 'decline' ? 'rejected' : 'appraised';
    const { rows: updatedRows } = await client.query(
      'UPDATE loans SET status = $1, updated_at = now() WHERE id = $2 RETURNING *',
      [newStatus, loanId]
    );

    await auditLog.record(client, {
      userId: appraiserId,
      branchId: loan.branch_id,
      action: 'loan.appraised',
      entityType: 'loan',
      entityId: loanId,
      beforeState: { status: loan.status },
      afterState: { status: newStatus, appraisal: appraisalRows[0] },
    });

    await client.query('COMMIT');
    return { appraisal: appraisalRows[0], loan: updatedRows[0] };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function listAppraisals(pool, { loanId }) {
  const { rows } = await pool.query('SELECT * FROM loan_appraisals WHERE loan_id = $1 ORDER BY created_at', [loanId]);
  return rows;
}

// --- Approval (maker-checker via the shared service) ------------------------

/**
 * Requests dual-control approval to disburse. Deliberately does NOT create
 * a `loan_approvals` table (which the module prompt's data model
 * suggests) — the shared `approval_requests` record IS the maker-checker
 * trail, same call Modules 1 and 2 made. See Decisions_Log.md.
 */
async function requestLoanApproval(pool, { loanId, requestedBy }) {
  if (!requestedBy) throw new LoanValidationError('requestedBy is required');

  const loan = await getLoan(pool, loanId);
  if (loan.status !== 'appraised') {
    throw new LoanConflictError(
      `loan ${loanId} must be appraised before approval can be requested (status: ${loan.status})`
    );
  }

  const { rows: appraisalRows } = await pool.query('SELECT id FROM loan_appraisals WHERE loan_id = $1 LIMIT 1', [loanId]);
  if (appraisalRows.length === 0) {
    throw new LoanConflictError(`loan ${loanId} has no appraisal on record`);
  }

  const approvalRequest = await approvalWorkflow.requestApproval(pool, {
    actionType: 'loan.approve',
    entityType: 'loan',
    entityId: loanId,
    branchId: loan.branch_id,
    requestedBy,
    amountPesewas: Number(loan.principal_pesewas),
  });

  await pool.query("UPDATE loans SET status = 'pending_approval', updated_at = now() WHERE id = $1", [loanId]);

  return approvalRequest;
}

/** Registered as the 'loan.approve' execution handler — flips the loan to `approved` (or `rejected`). Disbursement stays a separate, explicitly-permissioned action. */
async function applyLoanApprovalDecision(approvalRequest, db) {
  const loanId = Number(approvalRequest.entity_id);
  const { rows: beforeRows } = await db.query('SELECT * FROM loans WHERE id = $1 FOR UPDATE', [loanId]);
  const before = beforeRows[0];
  if (!before) throw new LoanNotFoundError(`loan ${loanId} not found`);

  const { rows } = await db.query(
    "UPDATE loans SET status = 'approved', updated_at = now() WHERE id = $1 RETURNING *",
    [loanId]
  );

  await auditLog.record(db, {
    userId: approvalRequest.decided_by,
    branchId: before.branch_id,
    action: 'loan.approved',
    entityType: 'loan',
    entityId: loanId,
    beforeState: { status: before.status },
    afterState: { status: rows[0].status },
  });
}

// --- Disbursement -----------------------------------------------------------

async function getBranchGlAccounts(db, branchId) {
  const { rows } = await db.query('SELECT * FROM branch_gl_accounts WHERE branch_id = $1', [branchId]);
  if (!rows[0]) throw new LoanNotFoundError(`branch ${branchId} has no branch_gl_accounts row`);
  return rows[0];
}

/**
 * Verifies (and locks) that a loan is `approved` with a matching approved
 * maker-checker record — the shared precondition for BOTH ordinary
 * disbursement and overdraft activation.
 */
async function assertApprovedForDisbursement(client, loanId) {
  const { rows: loanRows } = await client.query('SELECT * FROM loans WHERE id = $1 FOR UPDATE', [loanId]);
  const loan = loanRows[0];
  if (!loan) throw new LoanNotFoundError(`loan ${loanId} not found`);
  if (loan.status !== 'approved') {
    throw new LoanConflictError(`loan ${loanId} must be approved before disbursement (status: ${loan.status})`);
  }

  const { rows: approvalRows } = await client.query(
    `SELECT id FROM approval_requests
      WHERE action_type = 'loan.approve' AND entity_type = 'loan' AND entity_id = $1 AND status = 'approved'
      LIMIT 1`,
    [String(loanId)]
  );
  if (approvalRows.length === 0) {
    throw new LoanConflictError(`loan ${loanId} has no approved maker-checker approval on record`);
  }

  // "Any concession above a threshold requires a second approval before
  // the loan can be disbursed" — enforced here, at the one gate function
  // both ordinary disbursement and overdraft activation already share,
  // rather than adding a second check site. A concession's own approval
  // is otherwise independent of the loan's loan.approve workflow (either
  // can be requested/decided before or after the other).
  const { rows: pendingConcessionRows } = await client.query(
    `SELECT lc.id FROM loan_concessions lc
       JOIN approval_requests ar ON ar.id = lc.approval_request_id
      WHERE lc.loan_id = $1 AND ar.status = 'pending'`,
    [loanId]
  );
  if (pendingConcessionRows.length > 0) {
    throw new LoanConflictError(`loan ${loanId} has a concession awaiting approval and cannot be disbursed yet`);
  }
  return loan;
}

/**
 * Activates an overdraft loan: NO schedule is generated and NOTHING posts
 * to GL — `principal_pesewas` is the approved LIMIT, and nothing is owed
 * until the customer actually draws against the linked savings account
 * (which happens through the ordinary withdrawal path once its real
 * numeric `overdraft_limit_pesewas` is set here). See Decisions_Log.md.
 */
async function activateOverdraft(pool, { loanId, disbursedBy, disbursementDate }) {
  const client = await pool.connect();
  let loan;
  try {
    await client.query('BEGIN');
    loan = await assertApprovedForDisbursement(client, loanId);

    // The linked account could have been closed (or gone dormant) in the
    // gap between application and disbursement — re-verify it here rather
    // than trusting the check applyForLoan already did at a different
    // point in time, so a closed account can never end up with a nonzero
    // overdraft_limit_pesewas.
    const { rows: accountRows } = await client.query('SELECT * FROM savings_accounts WHERE id = $1 FOR UPDATE', [
      loan.overdraft_savings_account_id,
    ]);
    const account = accountRows[0];
    if (!account) throw new LoanNotFoundError(`savings_account ${loan.overdraft_savings_account_id} not found`);
    if (account.status !== 'active') {
      throw new LoanConflictError(
        `savings_account ${loan.overdraft_savings_account_id} is not active (status: ${account.status}) — cannot activate the overdraft`
      );
    }

    await client.query('UPDATE savings_accounts SET overdraft_limit_pesewas = $1, updated_at = now() WHERE id = $2', [
      Number(loan.principal_pesewas),
      loan.overdraft_savings_account_id,
    ]);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const { rows } = await pool.query(
    `UPDATE loans
        SET status = 'disbursed', disbursed_at = now(), disbursed_by = $1, updated_at = now()
      WHERE id = $2
      RETURNING *`,
    [disbursedBy, loanId]
  );

  await auditLog.record(pool, {
    userId: disbursedBy,
    branchId: loan.branch_id,
    action: 'loan.overdraft_activated',
    entityType: 'loan',
    entityId: loanId,
    beforeState: { status: 'approved' },
    afterState: { status: 'disbursed', overdraftLimitPesewas: Number(loan.principal_pesewas), savingsAccountId: loan.overdraft_savings_account_id },
  });

  return { ...rows[0], feesPesewas: 0, netCashPesewas: 0, journalEntry: null };
}

/**
 * Disburses an approved loan: generates the repayment schedule, posts the
 * GL entry, and (for group loans) snapshots joint liability. Overdraft
 * loans are dispatched to `activateOverdraft` instead — see there for why.
 *
 * GL mapping (see Decisions_Log.md):
 *   Dr Loans Receivable   principal
 *     Cr Cash in Hand       principal - fees   (net cash actually handed over)
 *     Cr Loan Fee Income    fees               (fees netted at disbursement)
 *
 * The approving user must differ from the disbursing user is NOT enforced
 * here — maker-checker was already satisfied at the approval step
 * (requester != approver). Disbursement is a separate permissioned action.
 */
async function disburseLoan(pool, { loanId, disbursedBy, disbursementDate = todayIso() }) {
  if (!disbursedBy) throw new LoanValidationError('disbursedBy is required');

  const existingLoan = await getLoan(pool, loanId);
  if (existingLoan.loan_type === 'overdraft') {
    return activateOverdraft(pool, { loanId, disbursedBy, disbursementDate });
  }

  const client = await pool.connect();
  let loanForPosting;
  let feesPesewas;
  let glAccounts;

  try {
    await client.query('BEGIN');

    const loan = await assertApprovedForDisbursement(client, loanId);

    // Fees come from the LOAN's own snapshot, not the live product — a
    // product's fee_schedule can be edited after this loan applied (see
    // updateLoanProduct), and that must never silently change what this
    // loan is actually charged at disbursement. See migration
    // 055_loans_fee_schedule_snapshot.sql.
    feesPesewas = loanMath.computeFeesPesewas(loan.fee_schedule, Number(loan.principal_pesewas));
    if (feesPesewas >= Number(loan.principal_pesewas)) {
      throw new LoanValidationError(
        `computed fees (${feesPesewas}) must be less than the principal (${loan.principal_pesewas})`
      );
    }

    const schedule = loanMath.generateLoanSchedule({
      principalPesewas: Number(loan.principal_pesewas),
      termMonths: loan.term_months,
      annualInterestRateBps: loan.annual_interest_rate_bps,
      interestMethod: loan.interest_method,
      startDate: disbursementDate,
    });

    // Module 12: roll each due date forward past non-working days — see
    // calendarMath.js. Fetched once for the whole schedule's date range,
    // applied only at this GENERATION step, never retroactively.
    const calendarOverrides = await calendarService.getWorkingCalendarOverrides(client, {
      fromDate: disbursementDate,
      toDate: schedule[schedule.length - 1].dueDate,
    });

    for (const row of schedule) {
      const dueDate = calendarMath.rollForwardToWorkingDay(row.dueDate, calendarOverrides);
      await client.query(
        `INSERT INTO loan_schedules
           (loan_id, schedule_version, installment_number, due_date, principal_due_pesewas, interest_due_pesewas)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [loanId, loan.current_schedule_version, row.installmentNumber, dueDate, row.principalDuePesewas, row.interestDuePesewas]
      );
    }

    // Snapshot joint liability for group loans — group membership can
    // change later, but liability for THIS loan should not shift with it.
    if (loan.loan_type === 'group') {
      await client.query(
        `INSERT INTO loan_group_liabilities (loan_id, customer_id)
         SELECT $1, gm.customer_id
           FROM groups g
           JOIN group_members gm ON gm.group_id = g.id AND gm.left_at IS NULL
          WHERE g.customer_id = $2
         ON CONFLICT DO NOTHING`,
        [loanId, loan.customer_id]
      );
    }

    glAccounts = await getBranchGlAccounts(client, loan.branch_id);
    loanForPosting = loan;

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Posted after the schedule commits because postJournalEntry owns its
  // own transaction (it is the single funnel every module posts through —
  // see Decisions_Log.md). If this throws, the loan stays `approved` with
  // a schedule but no GL entry and no disbursed_at, which is a safe,
  // retryable state — no money has moved.
  const principalPesewas = Number(loanForPosting.principal_pesewas);
  const netCashPesewas = principalPesewas - feesPesewas;
  const lines = [
    { accountId: glAccounts.loans_receivable_account_id, debitPesewas: principalPesewas, branchId: loanForPosting.branch_id },
    { accountId: glAccounts.cash_in_hand_account_id, creditPesewas: netCashPesewas, branchId: loanForPosting.branch_id },
  ];
  if (feesPesewas > 0) {
    lines.push({ accountId: glAccounts.loan_fee_income_account_id, creditPesewas: feesPesewas, branchId: loanForPosting.branch_id });
  }

  const journalEntry = await glPosting.postJournalEntry(pool, {
    branchId: loanForPosting.branch_id,
    reference: `LOAN-${loanId}-DISB`,
    description: `Disbursement of loan ${loanId}`,
    entryDate: disbursementDate,
    sourceModule: 'loan',
    createdBy: disbursedBy,
    lines,
  });

  const { rows } = await pool.query(
    `UPDATE loans
        SET status = 'disbursed', disbursed_at = now(), disbursed_by = $1,
            disbursement_journal_entry_id = $2, updated_at = now()
      WHERE id = $3
      RETURNING *`,
    [disbursedBy, journalEntry.id, loanId]
  );

  await auditLog.record(pool, {
    userId: disbursedBy,
    branchId: loanForPosting.branch_id,
    action: 'loan.disbursed',
    entityType: 'loan',
    entityId: loanId,
    beforeState: { status: 'approved' },
    afterState: { status: 'disbursed', feesPesewas, netCashPesewas, journalEntryId: journalEntry.id },
  });

  return { ...rows[0], feesPesewas, netCashPesewas, journalEntry };
}

// --- Overdraft servicing -----------------------------------------------------

/** Current draw/limit/availability snapshot for an overdraft facility. */
async function getOverdraftStatus(pool, { loanId }) {
  const loan = await getLoan(pool, loanId);
  if (loan.loan_type !== 'overdraft') {
    throw new LoanValidationError(`loan ${loanId} is not an overdraft facility`);
  }
  const account = await savingsService.getAccount(pool, loan.overdraft_savings_account_id);
  const balancePesewas = Number(account.balance_pesewas);
  const drawnPesewas = Math.max(0, -balancePesewas);
  const limitPesewas = Number(account.overdraft_limit_pesewas);
  return {
    loanId: Number(loanId),
    status: loan.status,
    savingsAccountId: account.id,
    limitPesewas,
    balancePesewas,
    drawnPesewas,
    availablePesewas: Math.max(0, limitPesewas - drawnPesewas),
  };
}

/**
 * Accrues interest on the currently drawn overdraft balance and posts it —
 * this IS the interest recognition event (overdrafts have no schedule to
 * recognize interest against on receipt, unlike term loans — see
 * Decisions_Log.md). A no-op (0 accrued) when nothing is currently drawn.
 *
 * GL mapping: Dr Customer Deposits / Cr Loan Interest Income — same
 * direction as an ordinary withdrawal/fee, since Customer Deposits is a
 * liability and interest owed further reduces what's owed back to the
 * customer.
 */
async function accrueOverdraftInterest(pool, { loanId, accrualDate = todayIso(), days = 30, accruedBy }) {
  if (!accruedBy) throw new LoanValidationError('accruedBy is required');

  const loan = await getLoan(pool, loanId);
  if (loan.loan_type !== 'overdraft') {
    throw new LoanValidationError(`loan ${loanId} is not an overdraft facility`);
  }
  if (loan.status !== 'disbursed') {
    throw new LoanConflictError(`overdraft ${loanId} is not active (status: ${loan.status})`);
  }

  const account = await savingsService.getAccount(pool, loan.overdraft_savings_account_id);
  const drawnBalancePesewas = Math.max(0, -Number(account.balance_pesewas));
  if (drawnBalancePesewas <= 0) {
    return { loanId: Number(loanId), accrued: false, interestPesewas: 0 };
  }

  const interestPesewas = loanMath.computeOverdraftInterestPesewas({
    drawnBalancePesewas,
    annualInterestRateBps: loan.annual_interest_rate_bps,
    days,
  });
  // A zero (or 0%-rate) rounding result is a no-op, not an error — without
  // this, it would hit overdraft_interest_accruals' interest_pesewas > 0
  // CHECK constraint as a raw, unhelpful 500.
  if (interestPesewas <= 0) {
    return { loanId: Number(loanId), accrued: false, interestPesewas: 0 };
  }

  const { rows: existingRows } = await pool.query(
    'SELECT id FROM overdraft_interest_accruals WHERE loan_id = $1 AND accrual_date = $2',
    [loanId, accrualDate]
  );
  if (existingRows.length > 0) {
    throw new LoanConflictError(`overdraft ${loanId} already accrued interest for ${accrualDate}`);
  }

  const movement = await savingsService.applyMovement(pool, {
    accountId: account.id,
    txnType: 'overdraft_interest',
    deltaPesewas: -interestPesewas,
    description: `Overdraft interest on loan ${loanId}`,
    createdBy: accruedBy,
    entryDate: accrualDate,
    reference: `LOAN-${loanId}-ODINT-${accrualDate}`,
    minAllowedBalancePesewas: -Number(account.overdraft_limit_pesewas),
    buildGlLines: ({ glAccounts, branchId }) => [
      { accountId: glAccounts.customer_deposits_account_id, debitPesewas: interestPesewas, branchId },
      { accountId: glAccounts.loan_interest_income_account_id, creditPesewas: interestPesewas, branchId },
    ],
  });

  const { rows } = await pool.query(
    `INSERT INTO overdraft_interest_accruals
       (loan_id, savings_account_id, savings_transaction_id, accrual_date, drawn_balance_pesewas, annual_interest_rate_bps, interest_pesewas, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [loanId, account.id, movement.transaction.id, accrualDate, drawnBalancePesewas, loan.annual_interest_rate_bps, interestPesewas, accruedBy]
  );

  await auditLog.record(pool, {
    userId: accruedBy,
    branchId: loan.branch_id,
    action: 'loan.overdraft_interest_accrued',
    entityType: 'loan',
    entityId: loanId,
    afterState: { accrualDate, drawnBalancePesewas, interestPesewas, journalEntryId: movement.journalEntry.id },
  });

  return { loanId: Number(loanId), accrued: true, ...rows[0], interestPesewas, journalEntry: movement.journalEntry };
}

/**
 * Closes an overdraft facility: withdraws the approved limit
 * (`overdraft_limit_pesewas` back to 0, so the account can no longer be
 * drawn below its ordinary minimum balance) and marks the loan `closed`.
 * Requires the drawn balance to already be repaid to zero — same
 * "no outstanding debt" precondition as an ordinary savings account close.
 */
async function closeOverdraft(pool, { loanId, closedBy }) {
  if (!closedBy) throw new LoanValidationError('closedBy is required');

  const loan = await getLoan(pool, loanId);
  if (loan.loan_type !== 'overdraft') {
    throw new LoanValidationError(`loan ${loanId} is not an overdraft facility`);
  }
  if (loan.status !== 'disbursed') {
    throw new LoanConflictError(`overdraft ${loanId} is not active (status: ${loan.status})`);
  }

  const account = await savingsService.getAccount(pool, loan.overdraft_savings_account_id);
  if (Number(account.balance_pesewas) < 0) {
    throw new LoanConflictError(
      `overdraft ${loanId} cannot be closed with a drawn balance of ${-Number(account.balance_pesewas)} pesewas outstanding — repay it first`
    );
  }

  await pool.query('UPDATE savings_accounts SET overdraft_limit_pesewas = 0, updated_at = now() WHERE id = $1', [account.id]);
  const { rows } = await pool.query(
    "UPDATE loans SET status = 'closed', closed_at = now(), updated_at = now() WHERE id = $1 RETURNING *",
    [loanId]
  );

  await auditLog.record(pool, {
    userId: closedBy,
    branchId: loan.branch_id,
    action: 'loan.overdraft_closed',
    entityType: 'loan',
    entityId: loanId,
    beforeState: { status: 'disbursed' },
    afterState: { status: 'closed' },
  });

  return rows[0];
}

// --- Schedules & repayments -------------------------------------------------

async function getLoanSchedule(pool, { loanId, scheduleVersion = null }) {
  const loan = await getLoan(pool, loanId);
  const version = scheduleVersion || loan.current_schedule_version;
  const { rows } = await pool.query(
    'SELECT * FROM loan_schedules WHERE loan_id = $1 AND schedule_version = $2 ORDER BY installment_number',
    [loanId, version]
  );
  return rows;
}

function toMathRow(row) {
  return {
    id: row.id,
    principalDuePesewas: Number(row.principal_due_pesewas),
    principalPaidPesewas: Number(row.principal_paid_pesewas),
    interestDuePesewas: Number(row.interest_due_pesewas),
    interestPaidPesewas: Number(row.interest_paid_pesewas),
    feesDuePesewas: Number(row.fees_due_pesewas),
    feesPaidPesewas: Number(row.fees_paid_pesewas),
  };
}

/**
 * Posts a repayment. Allocation runs through the pure
 * loanMath.allocateRepayment waterfall (fees -> interest -> principal,
 * oldest installment first), so early/partial/late payments never require
 * regenerating the schedule.
 *
 * GL mapping (see Decisions_Log.md):
 *   Dr Cash in Hand            total received
 *     Cr Loans Receivable        principal component
 *     Cr Loan Interest Income    interest component
 *     Cr Loan Fee Income         fee component (if any)
 */
async function postRepayment(pool, { loanId, amountPesewas, paymentDate = todayIso(), receivedBy }) {
  if (!receivedBy) throw new LoanValidationError('receivedBy is required');
  if (!Number.isInteger(amountPesewas) || amountPesewas <= 0) {
    throw new LoanValidationError('amountPesewas must be a positive integer');
  }

  const client = await pool.connect();
  let context;

  try {
    await client.query('BEGIN');

    const { rows: loanRows } = await client.query('SELECT * FROM loans WHERE id = $1 FOR UPDATE', [loanId]);
    const loan = loanRows[0];
    if (!loan) throw new LoanNotFoundError(`loan ${loanId} not found`);
    if (loan.status !== 'disbursed') {
      throw new LoanConflictError(`loan ${loanId} is not open for repayment (status: ${loan.status})`);
    }

    const { rows: scheduleRows } = await client.query(
      `SELECT * FROM loan_schedules
        WHERE loan_id = $1 AND schedule_version = $2 AND status <> 'paid'
        ORDER BY installment_number`,
      [loanId, loan.current_schedule_version]
    );

    const { allocations, unallocatedPesewas } = loanMath.allocateRepayment(scheduleRows.map(toMathRow), amountPesewas);
    if (unallocatedPesewas > 0) {
      throw new LoanValidationError(
        `payment of ${amountPesewas} exceeds the outstanding balance by ${unallocatedPesewas} pesewas`
      );
    }

    const repaymentIds = [];
    let principalTotal = 0;
    let interestTotal = 0;
    let feesTotal = 0;

    for (const allocation of allocations) {
      const scheduleRow = scheduleRows.find((r) => Number(r.id) === Number(allocation.scheduleId));
      const newPrincipalPaid = Number(scheduleRow.principal_paid_pesewas) + allocation.principalPaidPesewas;
      const newInterestPaid = Number(scheduleRow.interest_paid_pesewas) + allocation.interestPaidPesewas;
      const newFeesPaid = Number(scheduleRow.fees_paid_pesewas) + allocation.feesPaidPesewas;
      const fullyPaid =
        newPrincipalPaid >= Number(scheduleRow.principal_due_pesewas) &&
        newInterestPaid >= Number(scheduleRow.interest_due_pesewas) &&
        newFeesPaid >= Number(scheduleRow.fees_due_pesewas);

      await client.query(
        `UPDATE loan_schedules
            SET principal_paid_pesewas = $1, interest_paid_pesewas = $2, fees_paid_pesewas = $3, status = $4
          WHERE id = $5`,
        [newPrincipalPaid, newInterestPaid, newFeesPaid, fullyPaid ? 'paid' : 'partially_paid', scheduleRow.id]
      );

      const allocationTotal =
        allocation.principalPaidPesewas + allocation.interestPaidPesewas + allocation.feesPaidPesewas;
      const { rows: repaymentRows } = await client.query(
        `INSERT INTO loan_repayments
           (loan_id, schedule_id, amount_pesewas, principal_component_pesewas, interest_component_pesewas,
            fees_component_pesewas, payment_date, received_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          loanId,
          scheduleRow.id,
          allocationTotal,
          allocation.principalPaidPesewas,
          allocation.interestPaidPesewas,
          allocation.feesPaidPesewas,
          paymentDate,
          receivedBy,
        ]
      );
      repaymentIds.push(repaymentRows[0].id);

      principalTotal += allocation.principalPaidPesewas;
      interestTotal += allocation.interestPaidPesewas;
      feesTotal += allocation.feesPaidPesewas;
    }

    const { rows: remainingRows } = await client.query(
      `SELECT COUNT(*)::int AS remaining FROM loan_schedules
        WHERE loan_id = $1 AND schedule_version = $2 AND status <> 'paid'`,
      [loanId, loan.current_schedule_version]
    );
    const fullyRepaid = remainingRows[0].remaining === 0;
    if (fullyRepaid) {
      await client.query("UPDATE loans SET status = 'closed', closed_at = now(), updated_at = now() WHERE id = $1", [loanId]);
    }

    const glAccounts = await getBranchGlAccounts(client, loan.branch_id);
    context = { loan, glAccounts, principalTotal, interestTotal, feesTotal, repaymentIds, fullyRepaid };

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const { loan, glAccounts, principalTotal, interestTotal, feesTotal, repaymentIds, fullyRepaid } = context;
  const lines = [{ accountId: glAccounts.cash_in_hand_account_id, debitPesewas: amountPesewas, branchId: loan.branch_id }];
  if (principalTotal > 0) {
    lines.push({ accountId: glAccounts.loans_receivable_account_id, creditPesewas: principalTotal, branchId: loan.branch_id });
  }
  if (interestTotal > 0) {
    lines.push({ accountId: glAccounts.loan_interest_income_account_id, creditPesewas: interestTotal, branchId: loan.branch_id });
  }
  if (feesTotal > 0) {
    lines.push({ accountId: glAccounts.loan_fee_income_account_id, creditPesewas: feesTotal, branchId: loan.branch_id });
  }

  const journalEntry = await glPosting.postJournalEntry(pool, {
    branchId: loan.branch_id,
    reference: `LOAN-${loanId}-RPY-${repaymentIds.join('_')}`,
    description: `Repayment on loan ${loanId}`,
    entryDate: paymentDate,
    sourceModule: 'loan',
    createdBy: receivedBy,
    lines,
  });

  await pool.query('UPDATE loan_repayments SET journal_entry_id = $1 WHERE id = ANY($2)', [journalEntry.id, repaymentIds]);

  await auditLog.record(pool, {
    userId: receivedBy,
    branchId: loan.branch_id,
    action: 'loan.repayment_posted',
    entityType: 'loan',
    entityId: loanId,
    afterState: { amountPesewas, principalTotal, interestTotal, feesTotal, journalEntryId: journalEntry.id, loanClosed: fullyRepaid },
  });

  return {
    loanId,
    amountPesewas,
    principalComponentPesewas: principalTotal,
    interestComponentPesewas: interestTotal,
    feesComponentPesewas: feesTotal,
    loanClosed: fullyRepaid,
    journalEntry,
  };
}

async function listRepayments(pool, { loanId }) {
  const { rows } = await pool.query(
    'SELECT * FROM loan_repayments WHERE loan_id = $1 ORDER BY payment_date, id',
    [loanId]
  );
  return rows;
}

// --- Restructuring (maker-checker) -------------------------------------------

/**
 * Requests a restructure. Applying it (on approval) regenerates the
 * schedule at a NEW schedule_version over the CURRENT outstanding
 * principal — the old version's rows and every repayment posted against
 * them stay untouched, satisfying "preserving the original schedule and
 * all prior repayment history for audit".
 */
async function requestRestructure(pool, { loanId, newTermMonths, newAnnualInterestRateBps, reason, requestedBy }) {
  if (!newTermMonths || newAnnualInterestRateBps === undefined || !reason || !requestedBy) {
    throw new LoanValidationError('newTermMonths, newAnnualInterestRateBps, reason, and requestedBy are required');
  }
  if (!Number.isInteger(newTermMonths) || newTermMonths <= 0) {
    throw new LoanValidationError('newTermMonths must be a positive integer');
  }

  const loan = await getLoan(pool, loanId);
  if (loan.status !== 'disbursed') {
    throw new LoanConflictError(`only a disbursed loan can be restructured (status: ${loan.status})`);
  }

  const { rows: pendingRows } = await pool.query(
    `SELECT lr.id FROM loan_restructures lr
       JOIN approval_requests ar ON ar.id = lr.approval_request_id
      WHERE lr.loan_id = $1 AND ar.status = 'pending'`,
    [loanId]
  );
  if (pendingRows.length > 0) {
    throw new LoanConflictError(`loan ${loanId} already has a pending restructure request`);
  }

  const approvalRequest = await approvalWorkflow.requestApproval(pool, {
    actionType: 'loan.restructure',
    entityType: 'loan',
    entityId: loanId,
    branchId: loan.branch_id,
    requestedBy,
    amountPesewas: Number(loan.principal_pesewas),
    payload: { newTermMonths, newAnnualInterestRateBps, reason },
  });

  const { rows } = await pool.query(
    `INSERT INTO loan_restructures
       (loan_id, approval_request_id, old_schedule_version, new_schedule_version, new_term_months, new_annual_interest_rate_bps, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      loanId,
      approvalRequest.id,
      loan.current_schedule_version,
      loan.current_schedule_version + 1,
      newTermMonths,
      newAnnualInterestRateBps,
      reason,
    ]
  );

  return { ...rows[0], approvalRequest };
}

/** Registered as the 'loan.restructure' execution handler. */
async function applyRestructureOnApproval(approvalRequest, db) {
  const loanId = Number(approvalRequest.entity_id);

  const { rows: restructureRows } = await db.query(
    'SELECT * FROM loan_restructures WHERE approval_request_id = $1',
    [approvalRequest.id]
  );
  const restructure = restructureRows[0];
  if (!restructure) throw new LoanNotFoundError(`no loan_restructures row for approval_request ${approvalRequest.id}`);

  const { rows: loanRows } = await db.query('SELECT * FROM loans WHERE id = $1 FOR UPDATE', [loanId]);
  const loan = loanRows[0];
  if (!loan) throw new LoanNotFoundError(`loan ${loanId} not found`);

  const { rows: currentSchedule } = await db.query(
    'SELECT * FROM loan_schedules WHERE loan_id = $1 AND schedule_version = $2',
    [loanId, loan.current_schedule_version]
  );
  const outstandingPrincipal = loanMath.computeOutstandingPrincipalPesewas(currentSchedule.map(toMathRow));
  if (outstandingPrincipal <= 0) {
    throw new LoanConflictError(`loan ${loanId} has no outstanding principal to restructure`);
  }

  const newVersion = loan.current_schedule_version + 1;
  const newSchedule = loanMath.generateLoanSchedule({
    principalPesewas: outstandingPrincipal,
    termMonths: restructure.new_term_months,
    annualInterestRateBps: restructure.new_annual_interest_rate_bps,
    interestMethod: loan.interest_method,
    startDate: todayIso(),
  });

  const calendarOverrides = await calendarService.getWorkingCalendarOverrides(db, {
    fromDate: todayIso(),
    toDate: newSchedule[newSchedule.length - 1].dueDate,
  });

  for (const row of newSchedule) {
    const dueDate = calendarMath.rollForwardToWorkingDay(row.dueDate, calendarOverrides);
    await db.query(
      `INSERT INTO loan_schedules
         (loan_id, schedule_version, installment_number, due_date, principal_due_pesewas, interest_due_pesewas)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [loanId, newVersion, row.installmentNumber, dueDate, row.principalDuePesewas, row.interestDuePesewas]
    );
  }

  await db.query(
    `UPDATE loans
        SET current_schedule_version = $1, term_months = $2, annual_interest_rate_bps = $3, updated_at = now()
      WHERE id = $4`,
    [newVersion, restructure.new_term_months, restructure.new_annual_interest_rate_bps, loanId]
  );

  await auditLog.record(db, {
    userId: approvalRequest.decided_by,
    branchId: loan.branch_id,
    action: 'loan.restructured',
    entityType: 'loan',
    entityId: loanId,
    beforeState: { scheduleVersion: loan.current_schedule_version, termMonths: loan.term_months },
    afterState: { scheduleVersion: newVersion, termMonths: restructure.new_term_months, outstandingPrincipal },
  });
}

// --- Concessions -------------------------------------------------------------

const LOAN_STATUSES_ELIGIBLE_FOR_CONCESSION = ['applied', 'appraised', 'pending_approval', 'approved'];

/**
 * Proposes a negotiated rate/spread, term, and/or fee schedule against a
 * loan's PRODUCT standard terms. "Standard" here always means the
 * product's CURRENT configuration (loan_products.annual_interest_rate_bps
 * /spread_bps), not whatever the loan itself currently has — if an
 * earlier concession already discounted this loan, a new request is
 * still evaluated against what a customer would get today under
 * standard terms, not against the already-discounted value, so the
 * floor/threshold bounds mean the same thing on every request regardless
 * of history. Term/fee "standard" values are the loan's own current
 * values instead (there's no single product-wide standard term/fee
 * config the way there is for rate — only a min/max range, already
 * enforced elsewhere), used purely to detect whether they changed at
 * all for the needsApproval decision.
 *
 * Rate/spread ARE bound-checked (loanMath.evaluateConcessionBounds,
 * against the product's min_rate_floor_bps/min_spread_floor_bps) —
 * reject outright, no approval route at all, if breached. Term is
 * bound-checked against the product's own min/max term (same limits an
 * ordinary application already respects). Fees are only checked for the
 * disbursement-time invariant (total fees < principal) — waiving a fee
 * has no separate floor of its own, but ANY fee or term change forces
 * needsApproval regardless of the rate delta (loanMath's rule), since
 * neither is quantifiable as a single bps discount the way rate is.
 */
async function requestConcession(pool, {
  loanId,
  negotiatedAnnualInterestRateBps = null,
  negotiatedSpreadBps = null,
  negotiatedTermMonths = null,
  negotiatedFeeSchedule = null,
  reasonCode,
  reasonNotes = null,
  requestedBy,
}) {
  if (!reasonCode || !requestedBy) {
    throw new LoanValidationError('reasonCode and requestedBy are required');
  }
  if (!['loyal_customer', 'competitive_match', 'hardship', 'other'].includes(reasonCode)) {
    throw new LoanValidationError("reasonCode must be one of 'loyal_customer', 'competitive_match', 'hardship', 'other'");
  }

  const loan = await getLoan(pool, loanId);
  if (!LOAN_STATUSES_ELIGIBLE_FOR_CONCESSION.includes(loan.status)) {
    throw new LoanConflictError(
      `loan ${loanId} cannot take a concession in its current status (${loan.status}) — must be applied, appraised, pending_approval, or approved`
    );
  }

  const { rows: pendingRows } = await pool.query(
    `SELECT lc.id FROM loan_concessions lc
       JOIN approval_requests ar ON ar.id = lc.approval_request_id
      WHERE lc.loan_id = $1 AND ar.status = 'pending'`,
    [loanId]
  );
  if (pendingRows.length > 0) {
    throw new LoanConflictError(`loan ${loanId} already has a concession awaiting approval`);
  }

  const product = await getLoanProduct(pool, loan.product_id);

  const termChanged = negotiatedTermMonths !== null && negotiatedTermMonths !== loan.term_months;
  if (termChanged && (negotiatedTermMonths < product.min_term_months || negotiatedTermMonths > product.max_term_months)) {
    throw new LoanValidationError(
      `negotiatedTermMonths ${negotiatedTermMonths} is outside product limits (${product.min_term_months}-${product.max_term_months})`
    );
  }

  const feesChanged = negotiatedFeeSchedule !== null && JSON.stringify(negotiatedFeeSchedule) !== JSON.stringify(loan.fee_schedule);
  if (feesChanged) {
    const feesPesewas = loanMath.computeFeesPesewas(negotiatedFeeSchedule, Number(loan.principal_pesewas));
    if (feesPesewas >= Number(loan.principal_pesewas)) {
      throw new LoanValidationError(`negotiated fees (${feesPesewas}) must be less than the principal (${loan.principal_pesewas})`);
    }
  }

  let standardAnnualInterestRateBps = product.annual_interest_rate_bps;
  let standardSpreadBps = null;
  let resolvedNegotiatedAnnualInterestRateBps = negotiatedAnnualInterestRateBps;

  const rateOrSpreadProposed = product.rate_type === 'fixed' ? negotiatedAnnualInterestRateBps !== null : negotiatedSpreadBps !== null;

  let bounds = { permitted: true, withinFloor: true, appliedFloorBps: null, deltaBps: 0, needsApproval: false };
  if (rateOrSpreadProposed) {
    if (product.rate_type === 'floating') {
      if (negotiatedSpreadBps === null) {
        throw new LoanValidationError('negotiatedSpreadBps is required to negotiate rate on a floating-rate product (not negotiatedAnnualInterestRateBps)');
      }
      standardSpreadBps = product.spread_bps;
      const referenceRate = await policyRateService.getPolicyRate(pool, product.reference_rate_id);
      resolvedNegotiatedAnnualInterestRateBps = loanMath.computeFloatingEffectiveRateBps({
        referenceRateBps: referenceRate.rate_bps,
        spreadBps: negotiatedSpreadBps,
      });
      bounds = loanMath.evaluateConcessionBounds({
        rateType: 'floating',
        standardAnnualInterestRateBps,
        negotiatedAnnualInterestRateBps: resolvedNegotiatedAnnualInterestRateBps,
        standardSpreadBps,
        negotiatedSpreadBps,
        minSpreadFloorBps: product.min_spread_floor_bps,
        concessionApprovalThresholdBps: product.concession_approval_threshold_bps,
        termChanged,
        feesChanged,
      });
    } else {
      if (negotiatedAnnualInterestRateBps === null) {
        throw new LoanValidationError('negotiatedAnnualInterestRateBps is required to negotiate rate on a fixed-rate product');
      }
      bounds = loanMath.evaluateConcessionBounds({
        rateType: 'fixed',
        standardAnnualInterestRateBps,
        negotiatedAnnualInterestRateBps,
        minRateFloorBps: product.min_rate_floor_bps,
        concessionApprovalThresholdBps: product.concession_approval_threshold_bps,
        termChanged,
        feesChanged,
      });
    }
    if (!bounds.permitted) {
      throw new LoanConflictError(
        bounds.appliedFloorBps === null
          ? `loan_product ${product.code} does not permit concessions (no floor configured)`
          : `negotiated ${product.rate_type === 'floating' ? 'spread' : 'rate'} breaches this product's floor of ${bounds.appliedFloorBps}bps`
      );
    }
  } else {
    resolvedNegotiatedAnnualInterestRateBps = loan.annual_interest_rate_bps;
    // Rate/spread weren't touched, but term/fees might have been — that
    // alone can still require approval per loanMath's rule.
    bounds = { permitted: true, withinFloor: true, appliedFloorBps: null, deltaBps: 0, needsApproval: termChanged || feesChanged };
    if (!termChanged && !feesChanged) {
      throw new LoanValidationError('at least one of negotiatedAnnualInterestRateBps/negotiatedSpreadBps, negotiatedTermMonths, or negotiatedFeeSchedule must be provided');
    }
  }

  const finalTermMonths = termChanged ? negotiatedTermMonths : loan.term_months;
  const finalFeeSchedule = feesChanged ? negotiatedFeeSchedule : loan.fee_schedule;

  let approvalRequest = null;
  if (bounds.needsApproval) {
    approvalRequest = await approvalWorkflow.requestApproval(pool, {
      actionType: 'loan.grant_concession',
      entityType: 'loan',
      entityId: loanId,
      branchId: loan.branch_id,
      requestedBy,
      amountPesewas: Number(loan.principal_pesewas),
      payload: {
        annualInterestRateBps: resolvedNegotiatedAnnualInterestRateBps,
        termMonths: finalTermMonths,
        feeSchedule: finalFeeSchedule,
      },
    });
  }

  const { rows } = await pool.query(
    `INSERT INTO loan_concessions
       (loan_id, requested_by, reason_code, reason_notes,
        standard_annual_interest_rate_bps, negotiated_annual_interest_rate_bps,
        standard_spread_bps, negotiated_spread_bps, applied_floor_bps,
        standard_term_months, negotiated_term_months,
        standard_fee_schedule, negotiated_fee_schedule, approval_request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING *`,
    [
      loanId,
      requestedBy,
      reasonCode,
      reasonNotes,
      standardAnnualInterestRateBps,
      resolvedNegotiatedAnnualInterestRateBps,
      standardSpreadBps,
      negotiatedSpreadBps,
      bounds.appliedFloorBps,
      loan.term_months,
      finalTermMonths,
      JSON.stringify(loan.fee_schedule),
      JSON.stringify(finalFeeSchedule),
      approvalRequest ? approvalRequest.id : null,
    ]
  );
  const concession = rows[0];

  if (!bounds.needsApproval) {
    // Within the product's grace window — applies immediately, same
    // "auto-pay below threshold" shape as cashierService.requestCashBack.
    await pool.query(
      `UPDATE loans SET annual_interest_rate_bps = $1, term_months = $2, fee_schedule = $3, updated_at = now() WHERE id = $4`,
      [resolvedNegotiatedAnnualInterestRateBps, finalTermMonths, JSON.stringify(finalFeeSchedule), loanId]
    );
    await auditLog.record(pool, {
      userId: requestedBy,
      branchId: loan.branch_id,
      action: 'loan.concession_auto_applied',
      entityType: 'loan',
      entityId: loanId,
      beforeState: { annualInterestRateBps: loan.annual_interest_rate_bps, termMonths: loan.term_months },
      afterState: { annualInterestRateBps: resolvedNegotiatedAnnualInterestRateBps, termMonths: finalTermMonths },
    });
  }

  return { ...concession, approvalRequest, needsApproval: bounds.needsApproval };
}

/** Registered as the 'loan.grant_concession' execution handler — applies the negotiated terms onto the loan once a human approves. */
async function applyConcessionOnApproval(approvalRequest, db) {
  const loanId = Number(approvalRequest.entity_id);
  const { rows: loanRows } = await db.query('SELECT * FROM loans WHERE id = $1 FOR UPDATE', [loanId]);
  const loan = loanRows[0];
  if (!loan) throw new LoanNotFoundError(`loan ${loanId} not found`);

  const { annualInterestRateBps, termMonths, feeSchedule } = approvalRequest.payload;

  const { rows } = await db.query(
    `UPDATE loans SET annual_interest_rate_bps = $1, term_months = $2, fee_schedule = $3, updated_at = now() WHERE id = $4 RETURNING *`,
    [annualInterestRateBps, termMonths, JSON.stringify(feeSchedule), loanId]
  );

  await auditLog.record(db, {
    userId: approvalRequest.decided_by,
    branchId: loan.branch_id,
    action: 'loan.concession_approved',
    entityType: 'loan',
    entityId: loanId,
    beforeState: { annualInterestRateBps: loan.annual_interest_rate_bps, termMonths: loan.term_months },
    afterState: { annualInterestRateBps: rows[0].annual_interest_rate_bps, termMonths: rows[0].term_months },
  });
}

/**
 * Lists a loan's concessions with the effective status joined in from
 * approval_requests (see migration 056's comment: there is no status
 * column on loan_concessions itself, to avoid ever going stale on a
 * rejected request). A NULL approval_request_id means it fell within the
 * product's grace window and applied immediately.
 */
async function listConcessions(pool, { loanId }) {
  const { rows } = await pool.query(
    `SELECT lc.*,
            COALESCE(ar.status, 'approved') AS status,
            ar.decided_by, ar.decided_at, ar.decision_reason
       FROM loan_concessions lc
       LEFT JOIN approval_requests ar ON ar.id = lc.approval_request_id
      WHERE lc.loan_id = $1
      ORDER BY lc.created_at DESC`,
    [loanId]
  );
  return rows;
}

// --- Write-off ---------------------------------------------------------------

/**
 * Writes off an overdraft's currently drawn balance as a bad debt. Unlike a
 * term loan, an overdraft's debt lives on the linked savings account's
 * negative balance (nothing was ever posted to Loans Receivable — see
 * Decisions_Log.md), so writing it off means bringing that balance back to
 * zero through the ordinary applyMovement funnel, not crediting Loans
 * Receivable.
 *
 * GL mapping: Dr Loan Loss Expense / Cr Customer Deposits.
 */
async function writeOffOverdraft(pool, { loan, reason, writtenOffBy, writeOffDate }) {
  const account = await savingsService.getAccount(pool, loan.overdraft_savings_account_id);
  const drawnBalancePesewas = Math.max(0, -Number(account.balance_pesewas));
  if (drawnBalancePesewas <= 0) {
    throw new LoanConflictError(`overdraft ${loan.id} has no drawn balance to write off`);
  }

  const movement = await savingsService.applyMovement(pool, {
    accountId: account.id,
    txnType: 'overdraft_writeoff',
    deltaPesewas: drawnBalancePesewas,
    description: `Write-off of overdraft loan ${loan.id}: ${reason}`,
    createdBy: writtenOffBy,
    entryDate: writeOffDate,
    reference: `LOAN-${loan.id}-WOFF`,
    buildGlLines: ({ glAccounts, branchId }) => [
      { accountId: glAccounts.loan_loss_expense_account_id, debitPesewas: drawnBalancePesewas, branchId },
      { accountId: glAccounts.customer_deposits_account_id, creditPesewas: drawnBalancePesewas, branchId },
    ],
  });

  await pool.query('UPDATE savings_accounts SET overdraft_limit_pesewas = 0, updated_at = now() WHERE id = $1', [account.id]);

  const { rows } = await pool.query(
    `UPDATE loans
        SET status = 'written_off', written_off_at = now(), written_off_by = $1,
            write_off_journal_entry_id = $2, updated_at = now()
      WHERE id = $3
      RETURNING *`,
    [writtenOffBy, movement.journalEntry.id, loan.id]
  );

  await auditLog.record(pool, {
    userId: writtenOffBy,
    branchId: loan.branch_id,
    action: 'loan.written_off',
    entityType: 'loan',
    entityId: loan.id,
    beforeState: { status: loan.status },
    afterState: { status: 'written_off', drawnBalancePesewas, reason, journalEntryId: movement.journalEntry.id },
  });

  return { ...rows[0], writtenOffPrincipalPesewas: drawnBalancePesewas, journalEntry: movement.journalEntry };
}

/**
 * Writes off a loan's outstanding principal as a bad debt. Overdraft loans
 * are dispatched to `writeOffOverdraft` instead — see there for why.
 *
 * GL mapping (see Decisions_Log.md):
 *   Dr Loan Loss Expense   outstanding principal
 *     Cr Loans Receivable    outstanding principal
 *
 * Only outstanding PRINCIPAL is written off — accrued-but-unpaid interest
 * was never recognized as income (interest is recognized on receipt, not
 * on accrual — see Decisions_Log.md), so there is nothing to reverse.
 */
async function writeOffLoan(pool, { loanId, reason, writtenOffBy, writeOffDate = todayIso() }) {
  if (!reason || !writtenOffBy) throw new LoanValidationError('reason and writtenOffBy are required');

  const loan = await getLoan(pool, loanId);
  if (loan.status !== 'disbursed') {
    throw new LoanConflictError(`only a disbursed loan can be written off (status: ${loan.status})`);
  }

  if (loan.loan_type === 'overdraft') {
    return writeOffOverdraft(pool, { loan, reason, writtenOffBy, writeOffDate });
  }

  const schedule = await getLoanSchedule(pool, { loanId });
  const outstandingPrincipal = loanMath.computeOutstandingPrincipalPesewas(schedule.map(toMathRow));
  if (outstandingPrincipal <= 0) {
    throw new LoanConflictError(`loan ${loanId} has no outstanding principal to write off`);
  }

  const glAccounts = await getBranchGlAccounts(pool, loan.branch_id);
  const journalEntry = await glPosting.postJournalEntry(pool, {
    branchId: loan.branch_id,
    reference: `LOAN-${loanId}-WOFF`,
    description: `Write-off of loan ${loanId}: ${reason}`,
    entryDate: writeOffDate,
    sourceModule: 'loan',
    createdBy: writtenOffBy,
    lines: [
      { accountId: glAccounts.loan_loss_expense_account_id, debitPesewas: outstandingPrincipal, branchId: loan.branch_id },
      { accountId: glAccounts.loans_receivable_account_id, creditPesewas: outstandingPrincipal, branchId: loan.branch_id },
    ],
  });

  const { rows } = await pool.query(
    `UPDATE loans
        SET status = 'written_off', written_off_at = now(), written_off_by = $1,
            write_off_journal_entry_id = $2, updated_at = now()
      WHERE id = $3
      RETURNING *`,
    [writtenOffBy, journalEntry.id, loanId]
  );

  await auditLog.record(pool, {
    userId: writtenOffBy,
    branchId: loan.branch_id,
    action: 'loan.written_off',
    entityType: 'loan',
    entityId: loanId,
    beforeState: { status: loan.status },
    afterState: { status: 'written_off', outstandingPrincipal, reason, journalEntryId: journalEntry.id },
  });

  return { ...rows[0], writtenOffPrincipalPesewas: outstandingPrincipal, journalEntry };
}

// --- Collateral & guarantors --------------------------------------------------

async function addCollateral(pool, { loanId, description, estimatedValuePesewas = null, createdBy }) {
  if (!description || !createdBy) throw new LoanValidationError('description and createdBy are required');
  const loan = await getLoan(pool, loanId);
  const { rows } = await pool.query(
    `INSERT INTO loan_collateral (loan_id, description, estimated_value_pesewas, created_by)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [loanId, description, estimatedValuePesewas, createdBy]
  );
  await auditLog.record(pool, {
    userId: createdBy,
    branchId: loan.branch_id,
    action: 'loan.collateral_added',
    entityType: 'loan',
    entityId: loanId,
    afterState: rows[0],
  });
  return rows[0];
}

async function verifyCollateral(pool, { collateralId, verificationStatus, verifiedBy }) {
  if (!['verified', 'rejected'].includes(verificationStatus)) {
    throw new LoanValidationError("verificationStatus must be 'verified' or 'rejected'");
  }
  const { rows } = await pool.query(
    `UPDATE loan_collateral SET verification_status = $1, verified_by = $2 WHERE id = $3 RETURNING *`,
    [verificationStatus, verifiedBy, collateralId]
  );
  if (!rows[0]) throw new LoanNotFoundError(`loan_collateral ${collateralId} not found`);
  const loan = await getLoan(pool, rows[0].loan_id);
  await auditLog.record(pool, {
    userId: verifiedBy,
    branchId: loan.branch_id,
    action: 'loan.collateral_verified',
    entityType: 'loan',
    entityId: rows[0].loan_id,
    afterState: rows[0],
  });
  return rows[0];
}

async function listCollateral(pool, { loanId }) {
  const { rows } = await pool.query('SELECT * FROM loan_collateral WHERE loan_id = $1 ORDER BY id', [loanId]);
  return rows;
}

async function addGuarantor(pool, params) {
  const { loanId, customerId = null, guarantorName = null, guarantorPhone = null, guaranteedAmountPesewas = null, createdBy } = params;
  if (!createdBy) throw new LoanValidationError('createdBy is required');
  if (!customerId && !guarantorName) {
    throw new LoanValidationError('either customerId or guarantorName is required');
  }
  const loan = await getLoan(pool, loanId);
  const { rows } = await pool.query(
    `INSERT INTO loan_guarantors (loan_id, customer_id, guarantor_name, guarantor_phone, guaranteed_amount_pesewas, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [loanId, customerId, guarantorName, guarantorPhone, guaranteedAmountPesewas, createdBy]
  );
  await auditLog.record(pool, {
    userId: createdBy,
    branchId: loan.branch_id,
    action: 'loan.guarantor_added',
    entityType: 'loan',
    entityId: loanId,
    afterState: rows[0],
  });
  return rows[0];
}

async function listGuarantors(pool, { loanId }) {
  const { rows } = await pool.query('SELECT * FROM loan_guarantors WHERE loan_id = $1 ORDER BY id', [loanId]);
  return rows;
}

// --- Arrears / aging report ----------------------------------------------------

/**
 * Aging report over currently-disbursed loans: for each loan, the oldest
 * unpaid installment's days-past-due drives its arrears bucket, and the
 * loan's full outstanding principal is counted as at-risk in that bucket
 * (standard PAR convention — PAR30 counts the whole exposure of a loan
 * 30+ days late, not just the late installment). Buckets come from each
 * loan's product configuration, never hardcoded.
 *
 * Consumed by Module 9 (Analytics) for PAR reporting. NOT the same thing
 * as BOG prudential loan classification (Module 8) — see Decisions_Log.md.
 */
async function getArrearsReport(pool, { branchId = null, asOfDate = todayIso() } = {}) {
  const params = [asOfDate];
  let branchFilter = '';
  if (branchId) {
    params.push(branchId);
    branchFilter = `AND l.branch_id = $${params.length}`;
  }

  const { rows } = await pool.query(
    `SELECT l.id AS loan_id, l.customer_id, l.branch_id, l.principal_pesewas,
            p.par_bucket_days,
            COALESCE(SUM(s.principal_due_pesewas - s.principal_paid_pesewas), 0) AS outstanding_principal_pesewas,
            MIN(CASE WHEN s.status <> 'paid' AND s.due_date < $1 THEN s.due_date END) AS oldest_unpaid_due_date
       FROM loans l
       JOIN loan_products p ON p.id = l.product_id
       JOIN loan_schedules s ON s.loan_id = l.id AND s.schedule_version = l.current_schedule_version
      WHERE l.status = 'disbursed' ${branchFilter}
      GROUP BY l.id, p.par_bucket_days`,
    params
  );

  const asOf = new Date(`${asOfDate}T00:00:00Z`);
  const loans = rows.map((row) => {
    const outstandingPrincipalPesewas = Number(row.outstanding_principal_pesewas);
    let daysOverdue = 0;
    if (row.oldest_unpaid_due_date) {
      const due = new Date(row.oldest_unpaid_due_date);
      daysOverdue = Math.max(Math.floor((asOf - due) / 86400000), 0);
    }
    return {
      loanId: Number(row.loan_id),
      customerId: Number(row.customer_id),
      branchId: Number(row.branch_id),
      outstandingPrincipalPesewas,
      daysOverdue,
      bucket: loanMath.bucketArrearsDays(daysOverdue, row.par_bucket_days),
    };
  });

  const totals = { totalOutstandingPesewas: 0, totalAtRiskPesewas: 0, buckets: {} };
  for (const loan of loans) {
    totals.totalOutstandingPesewas += loan.outstandingPrincipalPesewas;
    if (loan.bucket) {
      totals.totalAtRiskPesewas += loan.outstandingPrincipalPesewas;
      totals.buckets[loan.bucket] = (totals.buckets[loan.bucket] || 0) + loan.outstandingPrincipalPesewas;
    }
  }
  totals.parRatio = totals.totalOutstandingPesewas > 0 ? totals.totalAtRiskPesewas / totals.totalOutstandingPesewas : 0;

  return { asOfDate, branchId, loans, totals };
}

/** Call once at app startup so decide() can dispatch loan approvals/restructures. */
function registerLoanExecutionHandlers() {
  approvalWorkflow.registerExecutionHandler('loan.approve', applyLoanApprovalDecision);
  approvalWorkflow.registerExecutionHandler('loan.restructure', applyRestructureOnApproval);
  approvalWorkflow.registerExecutionHandler('loan.grant_concession', applyConcessionOnApproval);
}

module.exports = {
  createLoanProduct,
  updateLoanProduct,
  getLoanProduct,
  listLoanProducts,
  calculateLoan,
  applyForLoan,
  getLoan,
  listLoans,
  submitAppraisal,
  listAppraisals,
  requestLoanApproval,
  applyLoanApprovalDecision,
  disburseLoan,
  activateOverdraft,
  getOverdraftStatus,
  accrueOverdraftInterest,
  closeOverdraft,
  getLoanSchedule,
  postRepayment,
  listRepayments,
  requestRestructure,
  applyRestructureOnApproval,
  requestConcession,
  applyConcessionOnApproval,
  listConcessions,
  resetFloatingRateProducts,
  writeOffLoan,
  addCollateral,
  verifyCollateral,
  listCollateral,
  addGuarantor,
  listGuarantors,
  getArrearsReport,
  findGroupCreditBlockers,
  registerLoanExecutionHandlers,
  LoanValidationError,
  LoanNotFoundError,
  LoanConflictError,
};
