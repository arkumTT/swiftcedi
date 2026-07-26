'use strict';

// Exercises Module 3 (loanService.js) against a real Postgres instance:
// the full application -> appraisal -> maker-checker approval ->
// disbursement -> repayment -> closure lifecycle, GL posting correctness
// at each money-moving step, restructuring's schedule-versioning
// (preserving prior history), write-off, the group-default credit block,
// and arrears aging. The pure interest/allocation math is covered
// separately and exhaustively in tests/unit/loanMath.test.js.
// Requires TEST_DATABASE_URL — see backend/README.md.

require('dotenv').config();
const { Pool } = require('pg');
const { execFileSync } = require('child_process');
const path = require('path');

const loanService = require('../../src/modules/loan/loanService');
const savingsService = require('../../src/modules/savings/savingsService');
const branchService = require('../../src/modules/branch/branchService');
const customerService = require('../../src/modules/customer/customerService');
const approvalWorkflow = require('../../src/shared/approvalWorkflow');
const glPosting = require('../../src/shared/glPosting');

const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

describeIfDb('Module 3: loan management', () => {
  let pool;
  let branchId;
  let glAccounts;
  let ownerRoleId;
  let maker;
  let checker;

  beforeAll(async () => {
    execFileSync('node', [path.join(__dirname, '../../src/db/migrate.js'), '--test'], {
      env: { ...process.env },
      stdio: 'inherit',
    });

    pool = new Pool({ connectionString });

    // Same targeted-cleanup approach as the Module 1/2 suites — see
    // branchModule.test.js for why TRUNCATE ... CASCADE is unsafe against
    // branches/gl_accounts here. Loan tables are cleared first (they FK
    // out to customers, users, approval_requests, gl_journal_entries).
    await pool.query('TRUNCATE gl_journal_lines, gl_journal_entries RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE audit_log RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE loan_repayments RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE savings_transactions, susu_collections RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE overdraft_interest_accruals RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE investment_accruals RESTART IDENTITY CASCADE');
    for (const table of [
      'agent_reconciliations',
      'agent_locations',
      'agent_assignments',
      'field_agents',
      'dashboard_widget_configs',
      'bank_accounts',
      'gl_prior_period_adjustments',
      'day_close_snapshots',
      'gl_periods',
      'transaction_reversals',
      'cash_back_requests',
      'cashier_tills',
      'investment_redemptions',
      'investment_payouts',
      'investments',
      'investment_products',
      'standing_order_runs',
      'standing_orders',
      'susu_commissions',
      'agent_remittances',
      'susu_accounts',
      'withdrawal_requests',
      'savings_accounts',
      'savings_products',
      'loan_group_liabilities',
      'loan_guarantors',
      'loan_collateral',
      'loan_restructures',
      'loan_schedules',
      'loans',
      'loan_products',
      'account_closures',
      'credit_bureau_lookups',
      'customer_documents',
      'next_of_kin',
      'group_members',
      'groups',
      'customer_branch_transfers',
      'customers',
      'cross_branch_access_grants',
      'branch_staff_assignments',
      'branch_vault_configs',
      'approval_requests',
      'users',
    ]) {
      await pool.query(`DELETE FROM ${table}`);
    }
    // Scoped (not a blanket DELETE) so HQ's own branch_gl_accounts row
    // survives — nothing in any suite ever recreates it for HQ (it's
    // only ever created via branchService.createBranch(), which HQ
    // bypassed at seed time), so an unscoped delete here would leave HQ
    // permanently without one for the rest of this test run.
    await pool.query(
      "DELETE FROM branch_gl_accounts WHERE branch_id <> (SELECT id FROM branches WHERE code = 'HQ')"
    );
    // Scoped to exclude HQ for the same reason as the branch_gl_accounts
    // delete above — HQ's own sub-accounts (1000.HQ, 1010.HQ, ...) are
    // never recreated by any suite (only branchService.createBranch()
    // does that, and HQ bypassed it at seed time).
    await pool.query(
      "DELETE FROM gl_accounts WHERE branch_id IS NOT NULL AND branch_id <> (SELECT id FROM branches WHERE code = 'HQ')"
    );
    await pool.query("DELETE FROM branches WHERE code <> 'HQ'");
    await pool.query('DELETE FROM branch_clusters');
    await pool.query('DELETE FROM branch_regions');

    branchService.registerBranchExecutionHandlers();
    customerService.registerCustomerExecutionHandlers();
    loanService.registerLoanExecutionHandlers();
    savingsService.registerSavingsExecutionHandlers();

    const { rows: roleRows } = await pool.query("SELECT id FROM roles WHERE name = 'owner'");
    ownerRoleId = roleRows[0].id;

    maker = await createTestUser('loan-maker@test.local');
    checker = await createTestUser('loan-checker@test.local');

    const branch = await branchService.createBranch(pool, { code: 'LON-01', name: 'Loan Test Branch', createdBy: maker });
    branchId = branch.id;
    const { rows: glRows } = await pool.query('SELECT * FROM branch_gl_accounts WHERE branch_id = $1', [branchId]);
    glAccounts = glRows[0];
  });

  afterAll(async () => {
    await pool.end();
  });

  async function createTestUser(email) {
    const { rows } = await pool.query(
      `INSERT INTO users (full_name, email, password_hash, role_id, home_branch_id)
       VALUES ($1, $1, 'x', $2, (SELECT id FROM branches WHERE code = 'HQ')) RETURNING id`,
      [email, ownerRoleId]
    );
    return rows[0].id;
  }

  let ghanaCardSeq = 0;
  async function createVerifiedCustomer(name) {
    ghanaCardSeq += 1;
    const customer = await customerService.createCustomer(pool, {
      customerType: 'individual',
      branchId,
      fullName: name,
      ghanaCardNo: `GHA-9000000${String(ghanaCardSeq).padStart(2, '0')}-1`,
      createdBy: maker,
    });
    await customerService.updateKycStatus(pool, { customerId: customer.id, kycStatus: 'verified', actorId: maker });
    return customer;
  }

  let productSeq = 0;
  async function createProduct(overrides = {}) {
    productSeq += 1;
    return loanService.createLoanProduct(pool, {
      name: `Product ${productSeq}`,
      code: `P${productSeq}`,
      loanType: 'individual',
      interestMethod: 'reducing_balance',
      annualInterestRateBps: 2400,
      minTermMonths: 1,
      maxTermMonths: 24,
      minPrincipalPesewas: 1000,
      maxPrincipalPesewas: 100000000,
      feeSchedule: [],
      createdBy: maker,
      ...overrides,
    });
  }

  let savingsProductSeq = 0;
  async function createOverdraftSavingsProduct() {
    savingsProductSeq += 1;
    return savingsService.createSavingsProduct(pool, {
      name: `OD Savings ${savingsProductSeq}`,
      code: `ODSAV${savingsProductSeq}`,
      allowsOverdraft: true,
      // High enough that ordinary test withdrawals pay out immediately
      // rather than queuing for maker-checker approval — that flow is
      // already covered by savingsModule.test.js.
      withdrawalApprovalThresholdPesewas: 100000000,
      createdBy: maker,
    });
  }

  async function openOverdraftAccount(customer) {
    const product = await createOverdraftSavingsProduct();
    return savingsService.openAccount(pool, { customerId: customer.id, productId: product.id, createdBy: maker });
  }

  /** Runs decide() in its own transaction, the way the HTTP endpoint does. */
  async function decideAs(approvalId, decidedBy, decision = 'approved') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await approvalWorkflow.decide(client, { approvalId, decidedBy, decision });
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async function takeLoanToDisbursed({ product, customer, principalPesewas, termMonths, disbursementDate = '2026-01-01' }) {
    const loan = await loanService.applyForLoan(pool, {
      customerId: customer.id,
      productId: product.id,
      principalPesewas,
      termMonths,
      appliedBy: maker,
    });
    await loanService.submitAppraisal(pool, {
      loanId: loan.id,
      checklist: { verified: true },
      recommendation: 'recommend',
      appraiserId: maker,
    });
    const approval = await loanService.requestLoanApproval(pool, { loanId: loan.id, requestedBy: maker });
    await decideAs(approval.id, checker);
    return loanService.disburseLoan(pool, { loanId: loan.id, disbursedBy: maker, disbursementDate });
  }

  test('application is blocked for a customer who is not KYC-verified', async () => {
    const product = await createProduct();
    const unverified = await customerService.createCustomer(pool, {
      customerType: 'individual',
      branchId,
      fullName: 'Unverified Borrower',
      ghanaCardNo: 'GHA-800000001-1',
      createdBy: maker,
    });

    await expect(
      loanService.applyForLoan(pool, {
        customerId: unverified.id,
        productId: product.id,
        principalPesewas: 50000,
        termMonths: 6,
        appliedBy: maker,
      })
    ).rejects.toThrow(loanService.LoanConflictError);
  });

  test('principal/term outside the product limits is rejected', async () => {
    const product = await createProduct({ minPrincipalPesewas: 10000, maxPrincipalPesewas: 50000, maxTermMonths: 6 });
    const customer = await createVerifiedCustomer('Limits Borrower');

    await expect(
      loanService.applyForLoan(pool, { customerId: customer.id, productId: product.id, principalPesewas: 5000, termMonths: 3, appliedBy: maker })
    ).rejects.toThrow(loanService.LoanValidationError);
    await expect(
      loanService.applyForLoan(pool, { customerId: customer.id, productId: product.id, principalPesewas: 20000, termMonths: 12, appliedBy: maker })
    ).rejects.toThrow(loanService.LoanValidationError);
  });

  test('a loan cannot be disbursed before appraisal and maker-checker approval', async () => {
    const product = await createProduct();
    const customer = await createVerifiedCustomer('Sequence Borrower');
    const loan = await loanService.applyForLoan(pool, {
      customerId: customer.id,
      productId: product.id,
      principalPesewas: 50000,
      termMonths: 6,
      appliedBy: maker,
    });

    await expect(loanService.disburseLoan(pool, { loanId: loan.id, disbursedBy: maker })).rejects.toThrow(
      loanService.LoanConflictError
    );
    // ...and approval cannot even be requested before appraisal.
    await expect(loanService.requestLoanApproval(pool, { loanId: loan.id, requestedBy: maker })).rejects.toThrow(
      loanService.LoanConflictError
    );
  });

  test('maker cannot approve their own loan; a different checker can', async () => {
    const product = await createProduct();
    const customer = await createVerifiedCustomer('MakerChecker Borrower');
    const loan = await loanService.applyForLoan(pool, {
      customerId: customer.id,
      productId: product.id,
      principalPesewas: 50000,
      termMonths: 6,
      appliedBy: maker,
    });
    await loanService.submitAppraisal(pool, { loanId: loan.id, checklist: {}, recommendation: 'recommend', appraiserId: maker });
    const approval = await loanService.requestLoanApproval(pool, { loanId: loan.id, requestedBy: maker });

    await expect(decideAs(approval.id, maker)).rejects.toThrow(approvalWorkflow.MakerCheckerViolationError);

    await decideAs(approval.id, checker);
    const approved = await loanService.getLoan(pool, loan.id);
    expect(approved.status).toBe('approved');
  });

  test('a declined appraisal rejects the loan outright', async () => {
    const product = await createProduct();
    const customer = await createVerifiedCustomer('Declined Borrower');
    const loan = await loanService.applyForLoan(pool, {
      customerId: customer.id,
      productId: product.id,
      principalPesewas: 50000,
      termMonths: 6,
      appliedBy: maker,
    });
    const { loan: appraised } = await loanService.submitAppraisal(pool, {
      loanId: loan.id,
      checklist: {},
      recommendation: 'decline',
      appraiserId: maker,
    });
    expect(appraised.status).toBe('rejected');
  });

  test('disbursement generates the schedule and posts the GL entry with fees netted from cash', async () => {
    const product = await createProduct({ feeSchedule: [{ type: 'percent_of_principal', rateBps: 200 }] });
    const customer = await createVerifiedCustomer('Disbursement Borrower');

    const cashBefore = await glPosting.getAccountBalance(pool, { accountId: glAccounts.cash_in_hand_account_id, branchId });
    const receivableBefore = await glPosting.getAccountBalance(pool, { accountId: glAccounts.loans_receivable_account_id, branchId });
    const feeIncomeBefore = await glPosting.getAccountBalance(pool, { accountId: glAccounts.loan_fee_income_account_id, branchId });

    const disbursed = await takeLoanToDisbursed({ product, customer, principalPesewas: 100000, termMonths: 3 });
    expect(disbursed.status).toBe('disbursed');
    expect(disbursed.feesPesewas).toBe(2000);
    expect(disbursed.netCashPesewas).toBe(98000);

    const schedule = await loanService.getLoanSchedule(pool, { loanId: disbursed.id });
    expect(schedule).toHaveLength(3);
    expect(schedule.reduce((s, r) => s + Number(r.principal_due_pesewas), 0)).toBe(100000);

    const cashAfter = await glPosting.getAccountBalance(pool, { accountId: glAccounts.cash_in_hand_account_id, branchId });
    const receivableAfter = await glPosting.getAccountBalance(pool, { accountId: glAccounts.loans_receivable_account_id, branchId });
    const feeIncomeAfter = await glPosting.getAccountBalance(pool, { accountId: glAccounts.loan_fee_income_account_id, branchId });

    expect(cashAfter - cashBefore).toBe(-98000); // only the NET cash left the till
    expect(receivableAfter - receivableBefore).toBe(100000); // full principal is receivable
    expect(feeIncomeAfter - feeIncomeBefore).toBe(2000);
  });

  test('repayment allocates fees/interest/principal, posts to the GL, and closes the loan when fully repaid', async () => {
    const product = await createProduct();
    const customer = await createVerifiedCustomer('Repayment Borrower');
    const disbursed = await takeLoanToDisbursed({ product, customer, principalPesewas: 100000, termMonths: 3 });

    const schedule = await loanService.getLoanSchedule(pool, { loanId: disbursed.id });
    const firstInterest = Number(schedule[0].interest_due_pesewas);

    // Partial: covers interest first, then part of principal.
    const partial = await loanService.postRepayment(pool, {
      loanId: disbursed.id,
      amountPesewas: firstInterest + 5000,
      paymentDate: '2026-02-01',
      receivedBy: maker,
    });
    expect(partial.interestComponentPesewas).toBe(firstInterest);
    expect(partial.principalComponentPesewas).toBe(5000);
    expect(partial.loanClosed).toBe(false);

    const receivableAfterPartial = await glPosting.getAccountBalance(pool, {
      accountId: glAccounts.loans_receivable_account_id,
      branchId,
    });

    // Pay off everything that remains.
    const remaining = (await loanService.getLoanSchedule(pool, { loanId: disbursed.id })).reduce(
      (sum, r) =>
        sum +
        (Number(r.principal_due_pesewas) - Number(r.principal_paid_pesewas)) +
        (Number(r.interest_due_pesewas) - Number(r.interest_paid_pesewas)),
      0
    );
    const final = await loanService.postRepayment(pool, {
      loanId: disbursed.id,
      amountPesewas: remaining,
      paymentDate: '2026-04-01',
      receivedBy: maker,
    });
    expect(final.loanClosed).toBe(true);

    const closed = await loanService.getLoan(pool, disbursed.id);
    expect(closed.status).toBe('closed');
    expect(closed.closed_at).not.toBeNull();

    const receivableAfterFull = await glPosting.getAccountBalance(pool, {
      accountId: glAccounts.loans_receivable_account_id,
      branchId,
    });
    // Every pesewa of principal advanced on this loan has come back.
    expect(receivableAfterPartial - receivableAfterFull).toBe(95000);

    // Every repayment row is linked to its GL journal entry.
    const repayments = await loanService.listRepayments(pool, { loanId: disbursed.id });
    expect(repayments.length).toBeGreaterThan(0);
    expect(repayments.every((r) => r.journal_entry_id !== null)).toBe(true);
  });

  test('overpaying beyond the outstanding balance is rejected', async () => {
    const product = await createProduct();
    const customer = await createVerifiedCustomer('Overpay Borrower');
    const disbursed = await takeLoanToDisbursed({ product, customer, principalPesewas: 50000, termMonths: 3 });

    await expect(
      loanService.postRepayment(pool, { loanId: disbursed.id, amountPesewas: 99999999, receivedBy: maker })
    ).rejects.toThrow(loanService.LoanValidationError);
  });

  test('repayment against a closed loan is rejected', async () => {
    const product = await createProduct();
    const customer = await createVerifiedCustomer('Closed Loan Borrower');
    const disbursed = await takeLoanToDisbursed({ product, customer, principalPesewas: 30000, termMonths: 1 });

    const schedule = await loanService.getLoanSchedule(pool, { loanId: disbursed.id });
    const total = schedule.reduce((s, r) => s + Number(r.principal_due_pesewas) + Number(r.interest_due_pesewas), 0);
    await loanService.postRepayment(pool, { loanId: disbursed.id, amountPesewas: total, receivedBy: maker });

    await expect(
      loanService.postRepayment(pool, { loanId: disbursed.id, amountPesewas: 1000, receivedBy: maker })
    ).rejects.toThrow(loanService.LoanConflictError);
  });

  test('restructuring versions the schedule, preserves prior history, and re-amortizes exactly the outstanding principal', async () => {
    const product = await createProduct();
    const customer = await createVerifiedCustomer('Restructure Borrower');
    const disbursed = await takeLoanToDisbursed({ product, customer, principalPesewas: 100000, termMonths: 3 });

    const schedule = await loanService.getLoanSchedule(pool, { loanId: disbursed.id });
    const firstInterest = Number(schedule[0].interest_due_pesewas);
    await loanService.postRepayment(pool, {
      loanId: disbursed.id,
      amountPesewas: firstInterest + 18000,
      paymentDate: '2026-02-01',
      receivedBy: maker,
    });

    const restructure = await loanService.requestRestructure(pool, {
      loanId: disbursed.id,
      newTermMonths: 6,
      newAnnualInterestRateBps: 1800,
      reason: 'borrower distress',
      requestedBy: maker,
    });
    await decideAs(restructure.approvalRequest.id, checker);

    const loan = await loanService.getLoan(pool, disbursed.id);
    expect(loan.current_schedule_version).toBe(2);
    expect(loan.term_months).toBe(6);

    // Original schedule rows survive untouched, with their payments intact.
    const v1 = await loanService.getLoanSchedule(pool, { loanId: disbursed.id, scheduleVersion: 1 });
    expect(v1).toHaveLength(3);
    expect(Number(v1[0].principal_paid_pesewas)).toBe(18000);

    // New schedule re-amortizes exactly the 82000 that was still outstanding.
    const v2 = await loanService.getLoanSchedule(pool, { loanId: disbursed.id });
    expect(v2).toHaveLength(6);
    expect(v2.reduce((s, r) => s + Number(r.principal_due_pesewas), 0)).toBe(82000);

    // Repayment history is preserved across the restructure.
    const repayments = await loanService.listRepayments(pool, { loanId: disbursed.id });
    expect(repayments).toHaveLength(1);
  });

  test('a loan cannot have two pending restructure requests at once', async () => {
    const product = await createProduct();
    const customer = await createVerifiedCustomer('Double Restructure Borrower');
    const disbursed = await takeLoanToDisbursed({ product, customer, principalPesewas: 50000, termMonths: 6 });

    await loanService.requestRestructure(pool, {
      loanId: disbursed.id,
      newTermMonths: 9,
      newAnnualInterestRateBps: 1800,
      reason: 'first',
      requestedBy: maker,
    });
    await expect(
      loanService.requestRestructure(pool, {
        loanId: disbursed.id,
        newTermMonths: 12,
        newAnnualInterestRateBps: 1800,
        reason: 'second',
        requestedBy: maker,
      })
    ).rejects.toThrow(loanService.LoanConflictError);
  });

  test('write-off moves outstanding principal to loan loss expense and clears the receivable', async () => {
    const product = await createProduct();
    const customer = await createVerifiedCustomer('WriteOff Borrower');
    const disbursed = await takeLoanToDisbursed({ product, customer, principalPesewas: 60000, termMonths: 6 });

    const receivableBefore = await glPosting.getAccountBalance(pool, { accountId: glAccounts.loans_receivable_account_id, branchId });
    const lossBefore = await glPosting.getAccountBalance(pool, { accountId: glAccounts.loan_loss_expense_account_id, branchId });

    const written = await loanService.writeOffLoan(pool, { loanId: disbursed.id, reason: 'default', writtenOffBy: maker });
    expect(written.status).toBe('written_off');
    expect(written.writtenOffPrincipalPesewas).toBe(60000);

    const receivableAfter = await glPosting.getAccountBalance(pool, { accountId: glAccounts.loans_receivable_account_id, branchId });
    const lossAfter = await glPosting.getAccountBalance(pool, { accountId: glAccounts.loan_loss_expense_account_id, branchId });
    expect(receivableBefore - receivableAfter).toBe(60000);
    expect(lossAfter - lossBefore).toBe(60000);
  });

  test('group loan: liability is snapshotted at disbursement, and a member default blocks further group credit', async () => {
    const groupProduct = await createProduct({ loanType: 'group', interestMethod: 'flat', annualInterestRateBps: 1800 });
    const memberA = await createVerifiedCustomer('Group Member A');
    const memberB = await createVerifiedCustomer('Group Member B');

    const group = await customerService.createGroup(pool, { name: 'Test Solidarity Group', branchId, createdBy: maker });
    await customerService.updateKycStatus(pool, { customerId: group.customer_id, kycStatus: 'verified', actorId: maker });
    await customerService.addGroupMember(pool, { groupId: group.id, customerId: memberA.id, addedBy: maker });
    await customerService.addGroupMember(pool, { groupId: group.id, customerId: memberB.id, addedBy: maker });

    // An individual customer cannot take a group product, and vice versa.
    await expect(
      loanService.applyForLoan(pool, {
        customerId: memberA.id,
        productId: groupProduct.id,
        principalPesewas: 50000,
        termMonths: 4,
        appliedBy: maker,
      })
    ).rejects.toThrow(loanService.LoanValidationError);

    const disbursed = await takeLoanToDisbursed({
      product: groupProduct,
      customer: { id: group.customer_id },
      principalPesewas: 60000,
      termMonths: 4,
    });

    const { rows: liabilities } = await pool.query(
      'SELECT customer_id FROM loan_group_liabilities WHERE loan_id = $1 ORDER BY customer_id',
      [disbursed.id]
    );
    // pg returns BIGINT columns as strings — normalize both sides before comparing.
    expect(liabilities.map((r) => Number(r.customer_id)).sort()).toEqual([Number(memberA.id), Number(memberB.id)].sort());

    // Before any default, the group has no blockers.
    expect(await loanService.findGroupCreditBlockers(pool, group.customer_id)).toHaveLength(0);

    await loanService.writeOffLoan(pool, { loanId: disbursed.id, reason: 'group default', writtenOffBy: maker });

    const blockers = await loanService.findGroupCreditBlockers(pool, group.customer_id);
    expect(blockers).toHaveLength(2);

    await expect(
      loanService.applyForLoan(pool, {
        customerId: group.customer_id,
        productId: groupProduct.id,
        principalPesewas: 20000,
        termMonths: 3,
        appliedBy: maker,
      })
    ).rejects.toThrow(loanService.LoanConflictError);
  });

  test('arrears report buckets overdue loans by their product configuration', async () => {
    const product = await createProduct({ parBucketDays: [30, 60, 90] });
    const customer = await createVerifiedCustomer('Arrears Borrower');
    const disbursed = await takeLoanToDisbursed({
      product,
      customer,
      principalPesewas: 90000,
      termMonths: 3,
      disbursementDate: '2026-01-01',
    });

    // First installment falls due 2026-02-01; as of 2026-03-05 it is ~32 days late.
    const report = await loanService.getArrearsReport(pool, { branchId, asOfDate: '2026-03-05' });
    const entry = report.loans.find((l) => l.loanId === Number(disbursed.id));
    expect(entry.daysOverdue).toBe(32);
    expect(entry.bucket).toBe('31-60');
    expect(entry.outstandingPrincipalPesewas).toBe(90000);

    // Before the first due date it is not in arrears at all.
    const early = await loanService.getArrearsReport(pool, { branchId, asOfDate: '2026-01-15' });
    const earlyEntry = early.loans.find((l) => l.loanId === Number(disbursed.id));
    expect(earlyEntry.daysOverdue).toBe(0);
    expect(earlyEntry.bucket).toBeNull();
  });

  test('the loan calculator previews a schedule without creating anything', async () => {
    const product = await createProduct({ feeSchedule: [{ type: 'flat', amountPesewas: 1500 }] });
    const before = await pool.query('SELECT COUNT(*)::int AS c FROM loans');

    const preview = await loanService.calculateLoan(pool, {
      productId: product.id,
      principalPesewas: 120000,
      termMonths: 4,
      startDate: '2026-01-01',
    });
    expect(preview.schedule).toHaveLength(4);
    expect(preview.feesPesewas).toBe(1500);
    expect(preview.netDisbursedPesewas).toBe(118500);
    expect(preview.schedule.reduce((s, r) => s + r.principalDuePesewas, 0)).toBe(120000);

    const after = await pool.query('SELECT COUNT(*)::int AS c FROM loans');
    expect(after.rows[0].c).toBe(before.rows[0].c);
  });

  test('collateral and guarantors attach to a loan and carry verification status', async () => {
    const product = await createProduct();
    const customer = await createVerifiedCustomer('Collateral Borrower');
    const loan = await loanService.applyForLoan(pool, {
      customerId: customer.id,
      productId: product.id,
      principalPesewas: 50000,
      termMonths: 6,
      appliedBy: maker,
    });

    const collateral = await loanService.addCollateral(pool, {
      loanId: loan.id,
      description: 'Sewing machine',
      estimatedValuePesewas: 80000,
      createdBy: maker,
    });
    expect(collateral.verification_status).toBe('pending');

    const verified = await loanService.verifyCollateral(pool, {
      collateralId: collateral.id,
      verificationStatus: 'verified',
      verifiedBy: checker,
    });
    expect(verified.verification_status).toBe('verified');

    await loanService.addGuarantor(pool, {
      loanId: loan.id,
      guarantorName: 'External Guarantor',
      guaranteedAmountPesewas: 25000,
      createdBy: maker,
    });
    expect(await loanService.listGuarantors(pool, { loanId: loan.id })).toHaveLength(1);
  });

  test('loan_repayments rows are immutable at the DB layer apart from the one-time journal_entry_id stamp', async () => {
    const product = await createProduct();
    const customer = await createVerifiedCustomer('Immutable Borrower');
    const disbursed = await takeLoanToDisbursed({ product, customer, principalPesewas: 40000, termMonths: 2 });
    const schedule = await loanService.getLoanSchedule(pool, { loanId: disbursed.id });
    await loanService.postRepayment(pool, {
      loanId: disbursed.id,
      amountPesewas: Number(schedule[0].interest_due_pesewas) + 1000,
      receivedBy: maker,
    });
    const [repayment] = await loanService.listRepayments(pool, { loanId: disbursed.id });

    await expect(
      pool.query('UPDATE loan_repayments SET amount_pesewas = 1 WHERE id = $1', [repayment.id])
    ).rejects.toThrow(/immutable/);
    await expect(pool.query('DELETE FROM loan_repayments WHERE id = $1', [repayment.id])).rejects.toThrow(/immutable/);
    // The journal_entry_id stamp is already used (non-null), so even that path is now closed.
    await expect(
      pool.query('UPDATE loan_repayments SET journal_entry_id = NULL WHERE id = $1', [repayment.id])
    ).rejects.toThrow(/immutable/);
  });

  describe('overdraft loans', () => {
    test('application requires a linked savings account', async () => {
      const product = await createProduct({ loanType: 'overdraft' });
      const customer = await createVerifiedCustomer('OD No Account Borrower');

      await expect(
        loanService.applyForLoan(pool, {
          customerId: customer.id,
          productId: product.id,
          principalPesewas: 200000,
          termMonths: 12,
          appliedBy: maker,
        })
      ).rejects.toThrow(/overdraftSavingsAccountId is required/);
    });

    test('rejects a savings account that belongs to a different customer', async () => {
      const product = await createProduct({ loanType: 'overdraft' });
      const customer = await createVerifiedCustomer('OD Wrong Owner Borrower');
      const otherCustomer = await createVerifiedCustomer('OD Other Owner');
      const account = await openOverdraftAccount(otherCustomer);

      await expect(
        loanService.applyForLoan(pool, {
          customerId: customer.id,
          productId: product.id,
          principalPesewas: 200000,
          termMonths: 12,
          overdraftSavingsAccountId: account.id,
          appliedBy: maker,
        })
      ).rejects.toThrow(loanService.LoanValidationError);
    });

    test('rejects a savings account whose product does not allow overdraft', async () => {
      const product = await createProduct({ loanType: 'overdraft' });
      const customer = await createVerifiedCustomer('OD Non-Overdraft Product Borrower');
      const ordinaryProduct = await savingsService.createSavingsProduct(pool, {
        name: 'Ordinary Savings',
        code: `ORD${Date.now()}`,
        createdBy: maker,
      });
      const account = await savingsService.openAccount(pool, {
        customerId: customer.id,
        productId: ordinaryProduct.id,
        createdBy: maker,
      });

      await expect(
        loanService.applyForLoan(pool, {
          customerId: customer.id,
          productId: product.id,
          principalPesewas: 200000,
          termMonths: 12,
          overdraftSavingsAccountId: account.id,
          appliedBy: maker,
        })
      ).rejects.toThrow(loanService.LoanConflictError);
    });

    test('rejects overdraftSavingsAccountId on a non-overdraft product', async () => {
      const product = await createProduct(); // individual
      const customer = await createVerifiedCustomer('OD Mismatched Type Borrower');
      const account = await openOverdraftAccount(customer);

      await expect(
        loanService.applyForLoan(pool, {
          customerId: customer.id,
          productId: product.id,
          principalPesewas: 20000,
          termMonths: 6,
          overdraftSavingsAccountId: account.id,
          appliedBy: maker,
        })
      ).rejects.toThrow(/only applicable to overdraft loans/);
    });

    test('a second overdraft cannot be opened against an account that already has an active one', async () => {
      const product = await createProduct({ loanType: 'overdraft' });
      const customer = await createVerifiedCustomer('OD Double Facility Borrower');
      const account = await openOverdraftAccount(customer);

      await loanService.applyForLoan(pool, {
        customerId: customer.id,
        productId: product.id,
        principalPesewas: 100000,
        termMonths: 12,
        overdraftSavingsAccountId: account.id,
        appliedBy: maker,
      });

      await expect(
        loanService.applyForLoan(pool, {
          customerId: customer.id,
          productId: product.id,
          principalPesewas: 50000,
          termMonths: 12,
          overdraftSavingsAccountId: account.id,
          appliedBy: maker,
        })
      ).rejects.toThrow(/already has an active overdraft facility/);
    });

    test('activation posts no schedule and no GL entry; draws are limited to the real approved limit', async () => {
      const product = await createProduct({ loanType: 'overdraft', annualInterestRateBps: 3000 });
      const customer = await createVerifiedCustomer('OD Happy Path Borrower');
      const account = await openOverdraftAccount(customer);

      const loan = await loanService.applyForLoan(pool, {
        customerId: customer.id,
        productId: product.id,
        principalPesewas: 500000,
        termMonths: 12,
        overdraftSavingsAccountId: account.id,
        appliedBy: maker,
      });
      await loanService.submitAppraisal(pool, {
        loanId: loan.id,
        checklist: { verified: true },
        recommendation: 'recommend',
        appraiserId: maker,
      });
      const approval = await loanService.requestLoanApproval(pool, { loanId: loan.id, requestedBy: maker });
      await decideAs(approval.id, checker);

      const disbursed = await loanService.disburseLoan(pool, { loanId: loan.id, disbursedBy: maker });
      expect(disbursed.status).toBe('disbursed');
      expect(disbursed.journalEntry).toBeNull();
      expect(disbursed.disbursement_journal_entry_id).toBeNull();

      const schedule = await loanService.getLoanSchedule(pool, { loanId: loan.id });
      expect(schedule).toHaveLength(0);

      const updatedAccount = await savingsService.getAccount(pool, account.id);
      expect(Number(updatedAccount.overdraft_limit_pesewas)).toBe(500000);

      let status = await loanService.getOverdraftStatus(pool, { loanId: loan.id });
      expect(status).toMatchObject({ limitPesewas: 500000, balancePesewas: 0, drawnPesewas: 0, availablePesewas: 500000 });

      // Draw against the real limit via the ORDINARY withdrawal path.
      const draw = await savingsService.requestWithdrawal(pool, { accountId: account.id, amountPesewas: 300000, requestedBy: maker });
      expect(draw.paidOut).toBe(true);
      expect(draw.balanceAfterPesewas).toBe(-300000);

      status = await loanService.getOverdraftStatus(pool, { loanId: loan.id });
      expect(status).toMatchObject({ balancePesewas: -300000, drawnPesewas: 300000, availablePesewas: 200000 });

      // Drawing beyond the real limit is rejected — no unlimited bypass.
      await expect(
        savingsService.requestWithdrawal(pool, { accountId: account.id, amountPesewas: 250000, requestedBy: maker })
      ).rejects.toThrow(/overdraft limit/);

      // Accrue interest: balanced GL entry, debits Customer Deposits further.
      const accrual = await loanService.accrueOverdraftInterest(pool, {
        loanId: loan.id,
        accrualDate: '2026-02-01',
        days: 30,
        accruedBy: maker,
      });
      expect(accrual.accrued).toBe(true);
      const expectedInterest = Math.round((300000 * 3000 * 30) / (365 * 10000));
      expect(accrual.interestPesewas).toBe(expectedInterest);
      expect(accrual.journalEntry.lines).toHaveLength(2);
      const [line1, line2] = accrual.journalEntry.lines;
      expect(Number(line1.debit_pesewas) + Number(line2.debit_pesewas)).toBe(
        Number(line1.credit_pesewas) + Number(line2.credit_pesewas)
      );

      // Re-accruing on the same day is rejected (no double-accrual).
      await expect(
        loanService.accrueOverdraftInterest(pool, { loanId: loan.id, accrualDate: '2026-02-01', days: 30, accruedBy: maker })
      ).rejects.toThrow(/already accrued interest/);

      const afterAccrual = await savingsService.getAccount(pool, account.id);
      expect(Number(afterAccrual.balance_pesewas)).toBe(-300000 - expectedInterest);

      // Closing while still drawn is rejected.
      await expect(loanService.closeOverdraft(pool, { loanId: loan.id, closedBy: maker })).rejects.toThrow(
        /outstanding — repay it first/
      );

      // Repay the full drawn balance, then close.
      const outstanding = -Number(afterAccrual.balance_pesewas);
      await savingsService.deposit(pool, { accountId: account.id, amountPesewas: outstanding, depositedBy: maker });
      const closed = await loanService.closeOverdraft(pool, { loanId: loan.id, closedBy: maker });
      expect(closed.status).toBe('closed');

      const closedAccount = await savingsService.getAccount(pool, account.id);
      expect(Number(closedAccount.overdraft_limit_pesewas)).toBe(0);
      expect(Number(closedAccount.balance_pesewas)).toBe(0);
    });

    test('accrueOverdraftInterest is a no-op when nothing is drawn', async () => {
      const product = await createProduct({ loanType: 'overdraft' });
      const customer = await createVerifiedCustomer('OD No Draw Borrower');
      const account = await openOverdraftAccount(customer);
      const loan = await loanService.applyForLoan(pool, {
        customerId: customer.id,
        productId: product.id,
        principalPesewas: 100000,
        termMonths: 6,
        overdraftSavingsAccountId: account.id,
        appliedBy: maker,
      });
      await loanService.submitAppraisal(pool, { loanId: loan.id, checklist: {}, recommendation: 'recommend', appraiserId: maker });
      const approval = await loanService.requestLoanApproval(pool, { loanId: loan.id, requestedBy: maker });
      await decideAs(approval.id, checker);
      await loanService.disburseLoan(pool, { loanId: loan.id, disbursedBy: maker });

      const result = await loanService.accrueOverdraftInterest(pool, { loanId: loan.id, accruedBy: maker });
      expect(result).toEqual({ loanId: Number(loan.id), accrued: false, interestPesewas: 0 });
    });

    test('accrueOverdraftInterest is a no-op (not a constraint-violation error) when the computed interest rounds to zero', async () => {
      const product = await createProduct({ loanType: 'overdraft', annualInterestRateBps: 0 });
      const customer = await createVerifiedCustomer('OD Zero Rate Borrower');
      const account = await openOverdraftAccount(customer);
      const loan = await loanService.applyForLoan(pool, {
        customerId: customer.id,
        productId: product.id,
        principalPesewas: 100000,
        termMonths: 6,
        overdraftSavingsAccountId: account.id,
        appliedBy: maker,
      });
      await loanService.submitAppraisal(pool, { loanId: loan.id, checklist: {}, recommendation: 'recommend', appraiserId: maker });
      const approval = await loanService.requestLoanApproval(pool, { loanId: loan.id, requestedBy: maker });
      await decideAs(approval.id, checker);
      await loanService.disburseLoan(pool, { loanId: loan.id, disbursedBy: maker });
      await savingsService.requestWithdrawal(pool, { accountId: account.id, amountPesewas: 50000, requestedBy: maker });

      const result = await loanService.accrueOverdraftInterest(pool, { loanId: loan.id, days: 30, accruedBy: maker });
      expect(result).toEqual({ loanId: Number(loan.id), accrued: false, interestPesewas: 0 });
      // No row should have been written for a no-op accrual.
      const { rows } = await pool.query('SELECT id FROM overdraft_interest_accruals WHERE loan_id = $1', [loan.id]);
      expect(rows).toHaveLength(0);
    });

    test('activation is rejected if the linked savings account was closed after application but before disbursement', async () => {
      const product = await createProduct({ loanType: 'overdraft' });
      const customer = await createVerifiedCustomer('OD Closed Account Borrower');
      const account = await openOverdraftAccount(customer);
      const loan = await loanService.applyForLoan(pool, {
        customerId: customer.id,
        productId: product.id,
        principalPesewas: 100000,
        termMonths: 6,
        overdraftSavingsAccountId: account.id,
        appliedBy: maker,
      });
      await loanService.submitAppraisal(pool, { loanId: loan.id, checklist: {}, recommendation: 'recommend', appraiserId: maker });
      const approval = await loanService.requestLoanApproval(pool, { loanId: loan.id, requestedBy: maker });
      await decideAs(approval.id, checker);

      // The account is still at a zero balance and no overdraft limit is
      // set yet (activation hasn't run), so an ordinary close succeeds —
      // exactly the gap activateOverdraft must catch.
      await savingsService.closeAccount(pool, { accountId: account.id, closedBy: maker });

      await expect(loanService.disburseLoan(pool, { loanId: loan.id, disbursedBy: maker })).rejects.toThrow(
        /is not active \(status: closed\)/
      );

      const untouchedLoan = await loanService.getLoan(pool, loan.id);
      expect(untouchedLoan.status).toBe('approved');
    });

    test('write-off of a drawn overdraft debits Loan Loss Expense and credits Customer Deposits, zeroing the balance and the limit', async () => {
      const product = await createProduct({ loanType: 'overdraft' });
      const customer = await createVerifiedCustomer('OD Write-Off Borrower');
      const account = await openOverdraftAccount(customer);
      const loan = await loanService.applyForLoan(pool, {
        customerId: customer.id,
        productId: product.id,
        principalPesewas: 200000,
        termMonths: 6,
        overdraftSavingsAccountId: account.id,
        appliedBy: maker,
      });
      await loanService.submitAppraisal(pool, { loanId: loan.id, checklist: {}, recommendation: 'recommend', appraiserId: maker });
      const approval = await loanService.requestLoanApproval(pool, { loanId: loan.id, requestedBy: maker });
      await decideAs(approval.id, checker);
      await loanService.disburseLoan(pool, { loanId: loan.id, disbursedBy: maker });

      await savingsService.requestWithdrawal(pool, { accountId: account.id, amountPesewas: 150000, requestedBy: maker });

      const writtenOff = await loanService.writeOffLoan(pool, { loanId: loan.id, reason: 'absconded', writtenOffBy: maker });
      expect(writtenOff.status).toBe('written_off');
      expect(writtenOff.writtenOffPrincipalPesewas).toBe(150000);

      const lines = writtenOff.journalEntry.lines;
      const glAccounts = await savingsService.getBranchGlAccounts(pool, branchId);
      const expenseLine = lines.find((l) => Number(l.account_id) === Number(glAccounts.loan_loss_expense_account_id));
      const depositsLine = lines.find((l) => Number(l.account_id) === Number(glAccounts.customer_deposits_account_id));
      expect(Number(expenseLine.debit_pesewas)).toBe(150000);
      expect(Number(depositsLine.credit_pesewas)).toBe(150000);

      const finalAccount = await savingsService.getAccount(pool, account.id);
      expect(Number(finalAccount.balance_pesewas)).toBe(0);
      expect(Number(finalAccount.overdraft_limit_pesewas)).toBe(0);
    });
  });
});
