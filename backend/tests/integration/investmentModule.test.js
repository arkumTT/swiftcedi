'use strict';

// Exercises Module 5 (investmentService.js) against a real Postgres
// instance: booking -> maker-checker approval -> activation (no schedule,
// funding GL entry) -> interest accrual -> periodic payout (threshold-
// gated) and redemption (early with penalty, and at maturity), each GL
// posting's balance, and the investor statement. The pure accrual/penalty
// math is covered separately and exhaustively in
// tests/unit/investmentMath.test.js.
// Requires TEST_DATABASE_URL — see backend/README.md.

require('dotenv').config();
const { Pool } = require('pg');
const { execFileSync } = require('child_process');
const path = require('path');

const investmentService = require('../../src/modules/investment/investmentService');
const branchService = require('../../src/modules/branch/branchService');
const customerService = require('../../src/modules/customer/customerService');
const approvalWorkflow = require('../../src/shared/approvalWorkflow');

const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

describeIfDb('Module 5: investment management', () => {
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

    // Same targeted-cleanup approach as the other suites — see
    // branchModule.test.js for why TRUNCATE ... CASCADE is unsafe against
    // branches/gl_accounts here. Immutable tables need TRUNCATE.
    await pool.query('TRUNCATE gl_journal_lines, gl_journal_entries RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE audit_log RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE loan_repayments RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE savings_transactions, susu_collections RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE overdraft_interest_accruals RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE investment_accruals RESTART IDENTITY CASCADE');
    for (const table of [
      'job_run_history',
      'scheduled_jobs',
      'archived_records',
      'archive_policies',
      'backup_runs',
      'subscription_licences',
      'reminder_notifications',
      'working_calendar',
      'aml_flags',
      'aml_rules',
      'sanctions_screening_results',
      'sanctions_list_entries',
      'regulatory_report_submissions',
      'regulatory_report_templates',
      'tax_rates',
      'regulatory_ratio_definitions',
      'loan_classifications',
      'loan_classification_configs',
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
      'loan_concessions',
      'loan_schedules',
      'loans',
      'loan_products',
      'policy_rate_changes',
      'policy_rates',
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
      'approval_thresholds',
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
    investmentService.registerInvestmentExecutionHandlers();

    const { rows: roleRows } = await pool.query("SELECT id FROM roles WHERE name = 'owner'");
    ownerRoleId = roleRows[0].id;

    maker = await createTestUser('inv-maker@test.local');
    checker = await createTestUser('inv-checker@test.local');

    const branch = await branchService.createBranch(pool, { code: 'INV-01', name: 'Investment Test Branch', createdBy: maker });
    branchId = branch.id;
    glAccounts = await investmentService.getBranchGlAccounts(pool, branchId);
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

  let cardSeq = 0;
  async function createVerifiedCustomer(name) {
    cardSeq += 1;
    const customer = await customerService.createCustomer(pool, {
      customerType: 'individual',
      branchId,
      fullName: name,
      ghanaCardNo: `GHA-6000000${String(cardSeq).padStart(2, '0')}-1`,
      createdBy: maker,
    });
    await customerService.updateKycStatus(pool, { customerId: customer.id, kycStatus: 'verified', actorId: maker });
    return customer;
  }

  let productSeq = 0;
  async function createProduct(overrides = {}) {
    productSeq += 1;
    return investmentService.createInvestmentProduct(pool, {
      name: `Investment Product ${productSeq}`,
      code: `IP${productSeq}`,
      tenorMonths: 12,
      annualInterestRateBps: 1800,
      minPrincipalPesewas: 1000,
      payoutFrequency: 'at_maturity',
      earlyWithdrawalPenaltyBps: 5000,
      payoutApprovalThresholdPesewas: 100000000, // high — ordinary test payouts pay out immediately
      createdBy: maker,
      ...overrides,
    });
  }

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

  async function bookApproveActivate({ product, customer, principalPesewas, startDate = '2026-01-01' }) {
    const { investment, approvalRequest } = await investmentService.bookInvestment(pool, {
      customerId: customer.id,
      productId: product.id,
      principalPesewas,
      appliedBy: maker,
    });
    await decideAs(approvalRequest.id, checker);
    return investmentService.activateInvestment(pool, { investmentId: investment.id, activatedBy: maker, startDate });
  }

  function expectBalanced(journalEntry) {
    const totalDebit = journalEntry.lines.reduce((s, l) => s + Number(l.debit_pesewas), 0);
    const totalCredit = journalEntry.lines.reduce((s, l) => s + Number(l.credit_pesewas), 0);
    expect(totalDebit).toBe(totalCredit);
    return { totalDebit, totalCredit };
  }

  test('booking is blocked for a customer who is not KYC-verified', async () => {
    const product = await createProduct();
    const unverified = await customerService.createCustomer(pool, {
      customerType: 'individual',
      branchId,
      fullName: 'Unverified Investor',
      ghanaCardNo: 'GHA-500000001-1',
      createdBy: maker,
    });

    await expect(
      investmentService.bookInvestment(pool, {
        customerId: unverified.id,
        productId: product.id,
        principalPesewas: 50000,
        appliedBy: maker,
      })
    ).rejects.toThrow(investmentService.InvestmentConflictError);
  });

  test('principal outside the product limits is rejected', async () => {
    const product = await createProduct({ minPrincipalPesewas: 10000, maxPrincipalPesewas: 50000 });
    const customer = await createVerifiedCustomer('Limits Investor');

    await expect(
      investmentService.bookInvestment(pool, { customerId: customer.id, productId: product.id, principalPesewas: 5000, appliedBy: maker })
    ).rejects.toThrow(investmentService.InvestmentValidationError);
    await expect(
      investmentService.bookInvestment(pool, { customerId: customer.id, productId: product.id, principalPesewas: 60000, appliedBy: maker })
    ).rejects.toThrow(investmentService.InvestmentValidationError);
  });

  test('maker cannot approve their own booking; a different checker can, and activation is blocked before that', async () => {
    const product = await createProduct();
    const customer = await createVerifiedCustomer('Approval Investor');
    const { investment, approvalRequest } = await investmentService.bookInvestment(pool, {
      customerId: customer.id,
      productId: product.id,
      principalPesewas: 100000,
      appliedBy: maker,
    });

    await expect(
      investmentService.activateInvestment(pool, { investmentId: investment.id, activatedBy: maker })
    ).rejects.toThrow(investmentService.InvestmentConflictError);
    await expect(decideAs(approvalRequest.id, maker)).rejects.toThrow(approvalWorkflow.MakerCheckerViolationError);

    const decided = await decideAs(approvalRequest.id, checker);
    expect(decided.status).toBe('approved');
    const approvedInvestment = await investmentService.getInvestment(pool, investment.id);
    expect(approvedInvestment.status).toBe('approved');
  });

  test('activation posts no schedule concept and a balanced funding GL entry; nothing is owed beyond the principal until drawn', async () => {
    const product = await createProduct({ annualInterestRateBps: 1800, tenorMonths: 12 });
    const customer = await createVerifiedCustomer('Activation Investor');
    const activated = await bookApproveActivate({ product, customer, principalPesewas: 500000, startDate: '2026-01-01' });

    expect(activated.status).toBe('active');
    expect(activated.maturity_date.toISOString().slice(0, 10)).toBe('2027-01-01');
    expectBalanced(activated.journalEntry);
    const cashLine = activated.journalEntry.lines.find((l) => Number(l.account_id) === Number(glAccounts.cash_in_hand_account_id));
    const liabilityLine = activated.journalEntry.lines.find(
      (l) => Number(l.account_id) === Number(glAccounts.investment_deposits_payable_account_id)
    );
    expect(Number(cashLine.debit_pesewas)).toBe(500000);
    expect(Number(liabilityLine.credit_pesewas)).toBe(500000);
  });

  test('interest accrual posts a balanced entry, does not compound, and rejects double-accrual for the same day', async () => {
    const product = await createProduct({ annualInterestRateBps: 1800 });
    const customer = await createVerifiedCustomer('Accrual Investor');
    const activated = await bookApproveActivate({ product, customer, principalPesewas: 1000000, startDate: '2026-01-01' });

    const first = await investmentService.accrueInterest(pool, {
      investmentId: activated.id,
      accrualDate: '2026-01-31',
      days: 30,
      accruedBy: maker,
    });
    expect(first.accrued).toBe(true);
    const expected = Math.round((1000000 * 1800 * 30) / (365 * 10000));
    expect(first.interestPesewas).toBe(expected);
    expectBalanced(first.journalEntry);

    // A second accrual period computes on the SAME original principal, not
    // a compounded balance — same amount as the first period.
    const second = await investmentService.accrueInterest(pool, {
      investmentId: activated.id,
      accrualDate: '2026-03-02',
      days: 30,
      accruedBy: maker,
    });
    expect(second.interestPesewas).toBe(expected);

    await expect(
      investmentService.accrueInterest(pool, { investmentId: activated.id, accrualDate: '2026-01-31', days: 30, accruedBy: maker })
    ).rejects.toThrow(/already accrued interest/);
  });

  test('accrueInterest is a no-op (not a constraint-violation error) on a 0%-rate product', async () => {
    const product = await createProduct({ annualInterestRateBps: 0 });
    const customer = await createVerifiedCustomer('Zero Rate Investor');
    const activated = await bookApproveActivate({ product, customer, principalPesewas: 100000 });

    const result = await investmentService.accrueInterest(pool, { investmentId: activated.id, accrualDate: '2026-01-31', days: 30, accruedBy: maker });
    expect(result).toEqual({ investmentId: Number(activated.id), accrued: false, interestPesewas: 0 });
    const { rows } = await pool.query('SELECT id FROM investment_accruals WHERE investment_id = $1', [activated.id]);
    expect(rows).toHaveLength(0);
  });

  test('a periodic payout below the threshold pays out immediately and nets the statement to zero outstanding interest', async () => {
    const product = await createProduct({ payoutFrequency: 'monthly', payoutApprovalThresholdPesewas: 100000000, annualInterestRateBps: 1500 });
    const customer = await createVerifiedCustomer('Payout Investor');
    const activated = await bookApproveActivate({ product, customer, principalPesewas: 200000 });

    const accrual = await investmentService.accrueInterest(pool, { investmentId: activated.id, accrualDate: '2026-01-31', days: 30, accruedBy: maker });

    const payout = await investmentService.requestInvestmentPayout(pool, { investmentId: activated.id, requestedBy: maker });
    expect(payout.paidOut).toBe(true);
    expect(Number(payout.payoutRequest.amount_pesewas)).toBe(accrual.interestPesewas);
    expectBalanced(payout.journalEntry);

    const statement = await investmentService.getInvestorStatement(pool, { investmentId: activated.id });
    expect(statement.totalAccruedPesewas).toBe(accrual.interestPesewas);
    expect(statement.totalPaidOutPesewas).toBe(accrual.interestPesewas);
    expect(statement.outstandingInterestLiabilityPesewas).toBe(0);
  });

  test('a payout request exceeding the unpaid accrued balance is rejected', async () => {
    const product = await createProduct({ payoutFrequency: 'monthly' });
    const customer = await createVerifiedCustomer('Overpay Investor');
    const activated = await bookApproveActivate({ product, customer, principalPesewas: 200000 });
    await investmentService.accrueInterest(pool, { investmentId: activated.id, accrualDate: '2026-01-31', days: 30, accruedBy: maker });

    await expect(
      investmentService.requestInvestmentPayout(pool, { investmentId: activated.id, amountPesewas: 999999999, requestedBy: maker })
    ).rejects.toThrow(/exceeds the unpaid accrued interest/);
  });

  test('a payout at or above the threshold queues for maker-checker approval before paying out', async () => {
    const product = await createProduct({ payoutFrequency: 'monthly', payoutApprovalThresholdPesewas: 1000, annualInterestRateBps: 1800 });
    const customer = await createVerifiedCustomer('Threshold Payout Investor');
    const activated = await bookApproveActivate({ product, customer, principalPesewas: 1000000 });
    const accrual = await investmentService.accrueInterest(pool, { investmentId: activated.id, accrualDate: '2026-01-31', days: 30, accruedBy: maker });
    expect(accrual.interestPesewas).toBeGreaterThan(1000);

    const requested = await investmentService.requestInvestmentPayout(pool, { investmentId: activated.id, requestedBy: maker });
    expect(requested.paidOut).toBe(false);
    expect(requested.payoutRequest.status).toBe('pending');

    await expect(
      investmentService.settleApprovedInvestmentPayout(pool, { payoutId: requested.payoutRequest.id, paidBy: maker })
    ).rejects.toThrow(investmentService.InvestmentConflictError);

    await decideAs(requested.approvalRequest.id, checker);
    const settled = await investmentService.settleApprovedInvestmentPayout(pool, {
      payoutId: requested.payoutRequest.id,
      paidBy: maker,
      paymentReference: 'MOMO-REF-XYZ',
    });
    expect(settled.paidOut).toBe(true);
    expect(settled.payoutRequest.status).toBe('paid');
    expect(settled.payoutRequest.payment_reference).toBe('MOMO-REF-XYZ');
  });

  test('early redemption forfeits the configured penalty fraction of accrued interest but always returns full principal', async () => {
    const product = await createProduct({ annualInterestRateBps: 1800, tenorMonths: 12, earlyWithdrawalPenaltyBps: 5000 });
    const customer = await createVerifiedCustomer('Early Redemption Investor');
    const activated = await bookApproveActivate({ product, customer, principalPesewas: 400000, startDate: '2026-01-01' });
    const accrual = await investmentService.accrueInterest(pool, { investmentId: activated.id, accrualDate: '2026-01-31', days: 30, accruedBy: maker });

    const { redemption, approvalRequest } = await investmentService.requestRedemption(pool, {
      investmentId: activated.id,
      redemptionDate: '2026-02-01', // well before the 2027-01-01 maturity
      requestedBy: maker,
    });
    expect(redemption.is_early).toBe(true);
    const expectedPenalty = Math.round(accrual.interestPesewas * 0.5);
    expect(Number(redemption.penalty_pesewas)).toBe(expectedPenalty);
    expect(Number(redemption.interest_payable_pesewas)).toBe(accrual.interestPesewas - expectedPenalty);
    expect(Number(redemption.total_payout_pesewas)).toBe(400000 + accrual.interestPesewas - expectedPenalty);

    await expect(
      investmentService.confirmRedemptionPayout(pool, { redemptionId: redemption.id, confirmedBy: maker })
    ).rejects.toThrow(investmentService.InvestmentConflictError);

    await decideAs(approvalRequest.id, checker);
    const confirmed = await investmentService.confirmRedemptionPayout(pool, {
      redemptionId: redemption.id,
      paymentReference: 'MOMO-REDEEM-001',
      confirmedBy: maker,
    });

    expect(confirmed.investment.status).toBe('redeemed');
    expect(confirmed.redemption.status).toBe('paid');
    const { totalDebit, totalCredit } = expectBalanced(confirmed.journalEntry);
    expect(totalDebit).toBe(400000 + accrual.interestPesewas);
    const penaltyLine = confirmed.journalEntry.lines.find(
      (l) => Number(l.account_id) === Number(glAccounts.early_withdrawal_penalty_income_account_id)
    );
    expect(Number(penaltyLine.credit_pesewas)).toBe(expectedPenalty);
    expect(totalCredit).toBe(Number(confirmed.redemption.total_payout_pesewas) + expectedPenalty);

    // A second redemption request on the same (now terminal) investment is rejected.
    await expect(
      investmentService.requestRedemption(pool, { investmentId: activated.id, requestedBy: maker })
    ).rejects.toThrow(investmentService.InvestmentConflictError);
  });

  test('redemption at or after maturity applies no penalty regardless of the product configuration', async () => {
    const product = await createProduct({ annualInterestRateBps: 1800, tenorMonths: 1, earlyWithdrawalPenaltyBps: 5000 });
    const customer = await createVerifiedCustomer('At-Maturity Redemption Investor');
    const activated = await bookApproveActivate({ product, customer, principalPesewas: 300000, startDate: '2026-01-01' });
    expect(activated.maturity_date.toISOString().slice(0, 10)).toBe('2026-02-01');

    const accrual = await investmentService.accrueInterest(pool, { investmentId: activated.id, accrualDate: '2026-01-31', days: 30, accruedBy: maker });

    const { redemption, approvalRequest } = await investmentService.requestRedemption(pool, {
      investmentId: activated.id,
      redemptionDate: '2026-02-01', // exactly at maturity — not early
      requestedBy: maker,
    });
    expect(redemption.is_early).toBe(false);
    expect(Number(redemption.penalty_pesewas)).toBe(0);
    expect(Number(redemption.interest_payable_pesewas)).toBe(accrual.interestPesewas);
    expect(Number(redemption.total_payout_pesewas)).toBe(300000 + accrual.interestPesewas);

    await decideAs(approvalRequest.id, checker);
    const confirmed = await investmentService.confirmRedemptionPayout(pool, { redemptionId: redemption.id, confirmedBy: maker });
    expectBalanced(confirmed.journalEntry);
    // No penalty line should exist when penalty is zero.
    const penaltyLine = confirmed.journalEntry.lines.find(
      (l) => Number(l.account_id) === Number(glAccounts.early_withdrawal_penalty_income_account_id)
    );
    expect(penaltyLine).toBeUndefined();
  });

  test('redemption is rejected on an investment that is not active', async () => {
    const product = await createProduct();
    const customer = await createVerifiedCustomer('Not Active Investor');
    const { investment } = await investmentService.bookInvestment(pool, {
      customerId: customer.id,
      productId: product.id,
      principalPesewas: 100000,
      appliedBy: maker,
    });

    await expect(
      investmentService.requestRedemption(pool, { investmentId: investment.id, requestedBy: maker })
    ).rejects.toThrow(investmentService.InvestmentConflictError);
  });
});
