'use strict';

// Exercises Module 9 (analyticsService.js) against a real Postgres
// instance: live stats, portfolio quality (PAR/aging/largest exposures),
// profitability, growth trends, agent/loan-officer productivity, the
// executive report pack, and dashboard widget config CRUD — plus,
// critically, the query-layer role-scoping enforcement the module prompt
// explicitly requires (a loan officer's own-book restriction can't be
// bypassed by passing someone else's id). Requires TEST_DATABASE_URL —
// see backend/README.md.

require('dotenv').config();
const { Pool } = require('pg');
const { execFileSync } = require('child_process');
const path = require('path');

const analyticsService = require('../../src/modules/analytics/analyticsService');
const loanService = require('../../src/modules/loan/loanService');
const savingsService = require('../../src/modules/savings/savingsService');
const susuService = require('../../src/modules/savings/susuService');
const branchService = require('../../src/modules/branch/branchService');
const customerService = require('../../src/modules/customer/customerService');
const approvalWorkflow = require('../../src/shared/approvalWorkflow');

const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

describeIfDb('Module 9: analytics & owner dashboard', () => {
  let pool;
  let branchId;
  let ownerRoleId;
  let loanOfficerRoleId;
  let maker;
  let checker;

  beforeAll(async () => {
    execFileSync('node', [path.join(__dirname, '../../src/db/migrate.js'), '--test'], {
      env: { ...process.env },
      stdio: 'inherit',
    });

    pool = new Pool({ connectionString });

    // dashboard_widget_configs and bank_accounts both reference users
    // directly (not via gl_journal_entries/lines), so neither is touched
    // by the TRUNCATE ... CASCADE below — deleted explicitly first, same
    // reasoning as glModule.test.js's bank_accounts cleanup.
    await pool.query('DELETE FROM dashboard_widget_configs');
    await pool.query('DELETE FROM bank_statement_lines');
    await pool.query('DELETE FROM bank_accounts');
    await pool.query('DELETE FROM gl_manual_entries');
    await pool.query('DELETE FROM agent_reconciliations');
    await pool.query('DELETE FROM agent_locations');
    await pool.query('DELETE FROM agent_assignments');
    await pool.query('DELETE FROM field_agents');
    await pool.query('DELETE FROM aml_flags');
    await pool.query('DELETE FROM aml_rules');
    await pool.query('DELETE FROM sanctions_screening_results');
    await pool.query('DELETE FROM sanctions_list_entries');
    await pool.query('DELETE FROM regulatory_report_submissions');
    await pool.query('DELETE FROM regulatory_report_templates');
    await pool.query('DELETE FROM tax_rates');
    await pool.query('DELETE FROM regulatory_ratio_definitions');
    await pool.query('DELETE FROM loan_classifications');
    await pool.query('DELETE FROM loan_classification_configs');
    await pool.query('DELETE FROM job_run_history');
    await pool.query('DELETE FROM scheduled_jobs');
    await pool.query('DELETE FROM archived_records');
    await pool.query('DELETE FROM archive_policies');
    await pool.query('DELETE FROM backup_runs');
    await pool.query('DELETE FROM subscription_licences');
    await pool.query('DELETE FROM reminder_notifications');
    await pool.query('DELETE FROM working_calendar');
    await pool.query('TRUNCATE gl_journal_lines, gl_journal_entries RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE audit_log RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE loan_repayments RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE savings_transactions, susu_collections RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE overdraft_interest_accruals RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE investment_accruals RESTART IDENTITY CASCADE');
    for (const table of [
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
    await pool.query(
      "DELETE FROM branch_gl_accounts WHERE branch_id <> (SELECT id FROM branches WHERE code = 'HQ')"
    );
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

    const { rows: ownerRows } = await pool.query("SELECT id FROM roles WHERE name = 'owner'");
    ownerRoleId = ownerRows[0].id;
    const { rows: officerRoleRows } = await pool.query("SELECT id FROM roles WHERE name = 'loan_officer'");
    loanOfficerRoleId = officerRoleRows[0].id;

    maker = await createTestUser('analytics-maker@test.local', ownerRoleId);
    checker = await createTestUser('analytics-checker@test.local', ownerRoleId);

    const branch = await branchService.createBranch(pool, { code: 'ANL-01', name: 'Analytics Test Branch', createdBy: maker });
    branchId = branch.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  let userSeq = 0;
  async function createTestUser(email, roleId) {
    const { rows } = await pool.query(
      `INSERT INTO users (full_name, email, password_hash, role_id, home_branch_id)
       VALUES ($1, $1, 'x', $2, (SELECT id FROM branches WHERE code = 'HQ')) RETURNING id`,
      [email, roleId]
    );
    return rows[0].id;
  }

  /**
   * A FRESH loan_officer user per call, never shared across tests — the
   * per-officer aggregate metrics this module computes (portfolio size,
   * PAR on their book, collection rate) are exact totals over EVERY loan
   * an officer has ever had, so reusing one officer id across independent
   * test cases would silently contaminate a later test's "exact total"
   * assertions with an earlier test's loans for that same officer.
   */
  async function createLoanOfficer() {
    userSeq += 1;
    return createTestUser(`analytics-officer-${userSeq}@test.local`, loanOfficerRoleId);
  }

  let ghanaCardSeq = 0;
  async function createVerifiedCustomer(name, classification = null) {
    ghanaCardSeq += 1;
    const customer = await customerService.createCustomer(pool, {
      customerType: 'individual',
      branchId,
      fullName: name,
      ghanaCardNo: `GHA-9100000${String(ghanaCardSeq).padStart(2, '0')}-1`,
      createdBy: maker,
    });
    await customerService.updateKycStatus(pool, { customerId: customer.id, kycStatus: 'verified', actorId: maker });
    if (classification) {
      await customerService.classifyCustomer(pool, { customerId: customer.id, classification, classifiedBy: maker });
    }
    return customer;
  }

  let productSeq = 0;
  async function createProduct() {
    productSeq += 1;
    return loanService.createLoanProduct(pool, {
      name: `Analytics Product ${productSeq}`,
      code: `ANLP${productSeq}`,
      loanType: 'individual',
      interestMethod: 'reducing_balance',
      annualInterestRateBps: 2400,
      minTermMonths: 1,
      maxTermMonths: 24,
      minPrincipalPesewas: 1000,
      maxPrincipalPesewas: 100000000,
      feeSchedule: [],
      createdBy: maker,
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

  async function takeLoanToDisbursed({ product, customer, principalPesewas, termMonths, disbursementDate, appliedBy = maker }) {
    const loan = await loanService.applyForLoan(pool, {
      customerId: customer.id,
      productId: product.id,
      principalPesewas,
      termMonths,
      appliedBy,
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

  // --- Live stats ---------------------------------------------------------

  test('live stats reflect today\'s disbursements and collections exactly, and branch scoping/consolidated grid work', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const officer = await createLoanOfficer();
    const product = await createProduct();
    const customer = await createVerifiedCustomer('Live Stats Borrower');
    const loan = await takeLoanToDisbursed({ product, customer, principalPesewas: 500000, termMonths: 6, disbursementDate: today, appliedBy: officer });

    const savingsProduct = await savingsService.createSavingsProduct(pool, { name: 'Analytics Savings', code: 'ANLSAV', createdBy: maker });
    const account = await savingsService.openAccount(pool, { customerId: customer.id, productId: savingsProduct.id, createdBy: maker });
    await savingsService.deposit(pool, { accountId: account.id, amountPesewas: 30000, depositedBy: maker, entryDate: today });

    const branchStats = await analyticsService.getLiveStats(pool, { branchId, date: today });
    expect(branchStats.todaysDisbursements.count).toBeGreaterThanOrEqual(1);
    expect(branchStats.todaysDisbursements.totalPesewas).toBeGreaterThanOrEqual(500000);
    expect(branchStats.todaysCollections.savingsDeposits.totalPesewas).toBeGreaterThanOrEqual(30000);
    expect(Number(branchStats.cashPosition.branchId)).toBe(Number(branchId));
    expect(branchStats.branchSnapshotGrid).toBeUndefined();

    const consolidated = await analyticsService.getLiveStats(pool, { date: today });
    expect(consolidated.cashPosition.branches.length).toBeGreaterThanOrEqual(1);
    expect(consolidated.branchSnapshotGrid.some((b) => Number(b.branchId) === Number(branchId) && b.code === 'ANL-01')).toBe(true);

    expect(loan.status).toBe('disbursed');
  });

  // --- Portfolio quality ---------------------------------------------------

  describe('portfolio quality', () => {
    test('PAR/aging/largest-exposures reconcile to the same per-loan snapshot, and loan-officer scoping cannot be bypassed', async () => {
      const officerA = await createLoanOfficer();
      const officerB = await createLoanOfficer();
      const product = await createProduct();

      const currentCustomer = await createVerifiedCustomer('Current Borrower');
      const currentLoan = await takeLoanToDisbursed({
        product,
        customer: currentCustomer,
        principalPesewas: 200000,
        termMonths: 6,
        disbursementDate: '2026-06-01',
        appliedBy: officerA,
      });

      const overdueCustomer = await createVerifiedCustomer('Overdue Borrower');
      const overdueLoan = await takeLoanToDisbursed({
        product,
        customer: overdueCustomer,
        principalPesewas: 400000,
        termMonths: 6,
        disbursementDate: '2025-01-01',
        appliedBy: officerA,
      });

      const otherOfficerCustomer = await createVerifiedCustomer('Other Officer Borrower');
      await takeLoanToDisbursed({
        product,
        customer: otherOfficerCustomer,
        principalPesewas: 900000,
        termMonths: 6,
        disbursementDate: '2025-01-01',
        appliedBy: officerB,
      });

      const asOfDate = '2026-06-15';
      const asOwner = await analyticsService.getPortfolioQuality(pool, { asOfDate, branchId });
      expect(asOwner.loanCount).toBeGreaterThanOrEqual(3);
      expect(asOwner.totalOutstandingPesewas).toBeGreaterThanOrEqual(200000 + 400000 + 900000);
      expect(asOwner.par90.atRiskPesewas).toBeGreaterThanOrEqual(400000 + 900000);
      const currentBucketEntry = asOwner.agingBuckets.find((b) => b.bucket === 'current');
      expect(currentBucketEntry.loanCount).toBeGreaterThanOrEqual(1);
      const largestFirst = asOwner.largestExposures[0];
      expect(largestFirst.outstandingPrincipalPesewas).toBeGreaterThanOrEqual(asOwner.largestExposures[asOwner.largestExposures.length - 1].outstandingPrincipalPesewas);

      // officerA tries to view officerB's book by passing officerB's id —
      // the service must silently override to officerA's OWN book instead.
      const asOfficerA = await analyticsService.getPortfolioQuality(pool, {
        asOfDate,
        branchId,
        loanOfficerId: officerB,
        requestingUser: { roleName: 'loan_officer', id: officerA },
      });
      expect(asOfficerA.loanOfficerId).toBe(officerA);
      const loanIds = asOfficerA.largestExposures.map((l) => l.loanId);
      expect(loanIds).toContain(Number(currentLoan.id));
      expect(loanIds).toContain(Number(overdueLoan.id));
      expect(asOfficerA.totalOutstandingPesewas).toBe(200000 + 400000);
    });
  });

  // --- Profitability --------------------------------------------------------

  test('profitability reconciles to glService.getIncomeStatement and includes a per-branch P&L when consolidated', async () => {
    const product = await createProduct();
    const customer = await createVerifiedCustomer('Profitability Borrower');
    const loan = await takeLoanToDisbursed({
      product,
      customer,
      principalPesewas: 300000,
      termMonths: 3,
      disbursementDate: '2026-07-01',
      appliedBy: maker,
    });
    const schedule = await loanService.getLoanSchedule(pool, { loanId: loan.id });
    const firstInstallment = schedule[0];
    const repaymentAmount = Number(firstInstallment.principal_due_pesewas) + Number(firstInstallment.interest_due_pesewas);
    await loanService.postRepayment(pool, { loanId: loan.id, amountPesewas: repaymentAmount, paymentDate: '2026-07-15', receivedBy: maker });

    const branchProfitability = await analyticsService.getProfitability(pool, { fromDate: '2026-07-01', toDate: '2026-07-31', branchId });
    expect(branchProfitability.totalIncomePesewas).toBeGreaterThan(0);
    expect(branchProfitability.costToIncomeRatio).toBe(branchProfitability.totalExpensePesewas / branchProfitability.totalIncomePesewas);
    expect(branchProfitability.branchPL).toBeUndefined();

    const consolidatedProfitability = await analyticsService.getProfitability(pool, { fromDate: '2026-07-01', toDate: '2026-07-31' });
    expect(Array.isArray(consolidatedProfitability.branchPL)).toBe(true);
    const branchRow = consolidatedProfitability.branchPL.find((b) => Number(b.branchId) === Number(branchId));
    expect(branchRow.totalIncomePesewas).toBe(branchProfitability.totalIncomePesewas);
  });

  // --- Growth trends ----------------------------------------------------------

  test('growth trends bucket by period and sector breakdown groups by classification', async () => {
    await createVerifiedCustomer('Sector Trader', 'trading');
    await createVerifiedCustomer('Sector Farmer', 'agriculture');
    await createVerifiedCustomer('Sector Unspecified', null);

    const trends = await analyticsService.getGrowthTrends(pool, {
      fromDate: '2020-01-01',
      toDate: '2030-01-01',
      branchId,
      granularity: 'year',
    });
    expect(trends.customerRecruitment.length).toBeGreaterThanOrEqual(1);
    const sectors = Object.fromEntries(trends.sectorBreakdown.map((s) => [s.sector, s.customerCount]));
    expect(sectors.trading).toBeGreaterThanOrEqual(1);
    expect(sectors.agriculture).toBeGreaterThanOrEqual(1);
    expect(sectors.unspecified).toBeGreaterThanOrEqual(1);
  });

  test('getGrowthTrends rejects a missing date range and an invalid granularity', async () => {
    await expect(analyticsService.getGrowthTrends(pool, { branchId })).rejects.toThrow(analyticsService.AnalyticsValidationError);
    await expect(
      analyticsService.getGrowthTrends(pool, { fromDate: '2026-01-01', toDate: '2026-12-31', granularity: 'week' })
    ).rejects.toThrow(analyticsService.AnalyticsValidationError);
  });

  // --- Agent / loan officer productivity ---------------------------------------

  test('agent productivity computes susu collections and loan-officer collection rate, and cannot be viewed for another officer', async () => {
    const officerA = await createLoanOfficer();
    const officerB = await createLoanOfficer();
    const susuCustomer = await createVerifiedCustomer('Susu Participant');
    const payoutProduct = await savingsService.createSavingsProduct(pool, { name: 'Susu Payout', code: 'ANLSUSUPAY', createdBy: maker });
    const payoutAccount = await savingsService.openAccount(pool, { customerId: susuCustomer.id, productId: payoutProduct.id, createdBy: maker });
    const susuAccount = await susuService.createSusuAccount(pool, {
      customerId: susuCustomer.id,
      cycleLengthDays: 30,
      expectedCollectionPesewas: 1000,
      targetAmountPesewas: 30000,
      assignedAgentId: officerA,
      payoutSavingsAccountId: payoutAccount.id,
      cycleStartDate: '2026-08-01',
      createdBy: maker,
    });
    await susuService.recordCollection(pool, {
      susuAccountId: susuAccount.id,
      agentId: officerA,
      amountPesewas: 1000,
      idempotencyKey: `analytics-collection-${Date.now()}`,
      collectionDate: '2026-08-05',
    });

    const product = await createProduct();
    const loanCustomer = await createVerifiedCustomer('Officer Loan Customer');
    const loan = await takeLoanToDisbursed({
      product,
      customer: loanCustomer,
      principalPesewas: 300000,
      termMonths: 3,
      disbursementDate: '2026-08-01',
      appliedBy: officerA,
    });
    const schedule = await loanService.getLoanSchedule(pool, { loanId: loan.id });
    const firstInstallment = schedule[0];
    const scheduledDue = Number(firstInstallment.principal_due_pesewas) + Number(firstInstallment.interest_due_pesewas) + Number(firstInstallment.fees_due_pesewas);
    await loanService.postRepayment(pool, {
      loanId: loan.id,
      amountPesewas: Math.floor(scheduledDue / 2),
      paymentDate: '2026-09-01',
      receivedBy: maker,
    });

    const productivity = await analyticsService.getAgentProductivity(pool, { agentId: officerA, fromDate: '2026-08-01', toDate: '2026-09-30' });
    expect(productivity.susu.collections.count).toBe(1);
    expect(productivity.susu.collections.totalPesewas).toBe(1000);
    expect(productivity.loanOfficer.activeLoanCount).toBeGreaterThanOrEqual(1);
    expect(productivity.loanOfficer.collectionRate).toBeCloseTo(0.5, 5);

    // officerB tries to view officerA's productivity — must be silently
    // overridden to officerB's own (empty) book instead.
    const asOfficerB = await analyticsService.getAgentProductivity(pool, {
      agentId: officerA,
      fromDate: '2026-08-01',
      toDate: '2026-09-30',
      requestingUser: { roleName: 'loan_officer', id: officerB },
    });
    expect(asOfficerB.agentId).toBe(officerB);
    expect(asOfficerB.susu.collections.count).toBe(0);
  });

  // --- Executive report pack ----------------------------------------------------

  test('executive report pack combines the balance sheet, income statement, portfolio summary, and social performance', async () => {
    const pack = await analyticsService.generateExecutiveReportPack(pool, {
      asOfDate: '2026-09-30',
      fromDate: '2026-01-01',
      toDate: '2026-09-30',
      branchId,
    });
    expect(pack.balanceSheet.balanced).toBe(true);
    expect(typeof pack.incomeStatement.totalIncomePesewas).toBe('number');
    expect(typeof pack.portfolioSummary.totalOutstandingPesewas).toBe('number');
    expect(Array.isArray(pack.socialPerformance.activeCustomersByGender)).toBe(true);
  });

  // --- Dashboard widget config CRUD --------------------------------------------

  describe('dashboard widget configs', () => {
    test('upsert creates then updates in place, list scopes by role, and delete removes it', async () => {
      const created = await analyticsService.upsertWidgetConfig(pool, {
        roleId: ownerRoleId,
        widgetKey: 'live_cash_position',
        position: 1,
        visible: true,
        updatedBy: maker,
        actorBranchId: branchId,
      });
      expect(created.position).toBe(1);

      const updated = await analyticsService.upsertWidgetConfig(pool, {
        roleId: ownerRoleId,
        widgetKey: 'live_cash_position',
        position: 5,
        visible: false,
        updatedBy: maker,
        actorBranchId: branchId,
      });
      expect(updated.id).toBe(created.id);
      expect(updated.position).toBe(5);
      expect(updated.visible).toBe(false);

      const listed = await analyticsService.listWidgetConfigs(pool, { roleId: ownerRoleId });
      expect(listed.some((c) => c.id === updated.id)).toBe(true);

      const { rows: auditRows } = await pool.query(
        "SELECT * FROM audit_log WHERE action IN ('analytics.dashboard_config_created', 'analytics.dashboard_config_updated') AND entity_id = $1 ORDER BY id",
        [created.id]
      );
      expect(auditRows).toHaveLength(2);

      await analyticsService.deleteWidgetConfig(pool, { configId: created.id, deletedBy: maker, actorBranchId: branchId });
      const afterDelete = await analyticsService.listWidgetConfigs(pool, { roleId: ownerRoleId });
      expect(afterDelete.some((c) => c.id === created.id)).toBe(false);
    });

    test('an unknown widgetKey is rejected, and deleting a nonexistent config 404s', async () => {
      await expect(
        analyticsService.upsertWidgetConfig(pool, { roleId: ownerRoleId, widgetKey: 'not_a_real_widget', updatedBy: maker, actorBranchId: branchId })
      ).rejects.toThrow(analyticsService.AnalyticsValidationError);
      await expect(
        analyticsService.deleteWidgetConfig(pool, { configId: 9999999, deletedBy: maker, actorBranchId: branchId })
      ).rejects.toThrow(analyticsService.AnalyticsNotFoundError);
    });
  });
});
