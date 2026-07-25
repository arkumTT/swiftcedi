'use strict';

const auditLog = require('../../shared/auditLog');
const approvalWorkflow = require('../../shared/approvalWorkflow');
const glPosting = require('../../shared/glPosting');
const loanMath = require('./loanMath');

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

async function createLoanProduct(pool, params) {
  const {
    name,
    code,
    loanType,
    interestMethod,
    annualInterestRateBps,
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
  // Validate the fee schedule shape up front rather than discovering a bad
  // fee config at disbursement time, when money is moving.
  loanMath.computeFeesPesewas(feeSchedule, 100000);

  const { rows } = await pool.query(
    `INSERT INTO loan_products
       (name, code, loan_type, interest_method, annual_interest_rate_bps, min_term_months, max_term_months,
        min_principal_pesewas, max_principal_pesewas, fee_schedule, par_bucket_days, reason_codes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING *`,
    [
      name,
      String(code).toUpperCase(),
      loanType,
      interestMethod,
      annualInterestRateBps,
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
  const { customerId, productId, principalPesewas, termMonths, reasonCode = null, purposeNotes = null, appliedBy } = params;
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

  const { rows } = await pool.query(
    `INSERT INTO loans
       (loan_type, customer_id, branch_id, product_id, principal_pesewas, term_months,
        interest_method, annual_interest_rate_bps, reason_code, purpose_notes, applied_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
      reasonCode,
      purposeNotes,
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
 * Disburses an approved loan: generates the repayment schedule, posts the
 * GL entry, and (for group loans) snapshots joint liability.
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

  const client = await pool.connect();
  let loanForPosting;
  let feesPesewas;
  let glAccounts;

  try {
    await client.query('BEGIN');

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

    const product = await getLoanProduct(client, loan.product_id);
    feesPesewas = loanMath.computeFeesPesewas(product.fee_schedule, Number(loan.principal_pesewas));
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

    for (const row of schedule) {
      await client.query(
        `INSERT INTO loan_schedules
           (loan_id, schedule_version, installment_number, due_date, principal_due_pesewas, interest_due_pesewas)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [loanId, loan.current_schedule_version, row.installmentNumber, row.dueDate, row.principalDuePesewas, row.interestDuePesewas]
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

  for (const row of newSchedule) {
    await db.query(
      `INSERT INTO loan_schedules
         (loan_id, schedule_version, installment_number, due_date, principal_due_pesewas, interest_due_pesewas)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [loanId, newVersion, row.installmentNumber, row.dueDate, row.principalDuePesewas, row.interestDuePesewas]
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

// --- Write-off ---------------------------------------------------------------

/**
 * Writes off a loan's outstanding principal as a bad debt.
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
}

module.exports = {
  createLoanProduct,
  getLoanProduct,
  listLoanProducts,
  calculateLoan,
  applyForLoan,
  getLoan,
  listLoans,
  submitAppraisal,
  requestLoanApproval,
  applyLoanApprovalDecision,
  disburseLoan,
  getLoanSchedule,
  postRepayment,
  listRepayments,
  requestRestructure,
  applyRestructureOnApproval,
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
