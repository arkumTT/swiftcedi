'use strict';

// Exercises Module 8 (complianceService.js) against a real Postgres
// instance: loan classification (BOG categories, reusing Module 9's
// getLoanBookSnapshot), the generic configurable ratio-computation engine
// (standing in for CAR/liquidity without hardcoding either formula),
// GRA withholding-tax/VAT summaries, versioned report templates +
// generation, and the AML/sanctions workflows — both of which must never
// auto-resolve a finding. Every regulation-dependent figure (thresholds,
// rates, ratio definitions) is configured explicitly in this file's own
// setup, never assumed as a shipped default — see Decisions_Log.md.
// Requires TEST_DATABASE_URL — see backend/README.md.

require('dotenv').config();
const { Pool } = require('pg');
const { execFileSync } = require('child_process');
const path = require('path');

const complianceService = require('../../src/modules/compliance/complianceService');
const loanService = require('../../src/modules/loan/loanService');
const savingsService = require('../../src/modules/savings/savingsService');
const branchService = require('../../src/modules/branch/branchService');
const customerService = require('../../src/modules/customer/customerService');
const investmentService = require('../../src/modules/investment/investmentService');
const approvalWorkflow = require('../../src/shared/approvalWorkflow');
const glPosting = require('../../src/shared/glPosting');

const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

describeIfDb('Module 8: regulatory & compliance reporting', () => {
  let pool;
  let branchId;
  let glAccounts;
  let ownerRoleId;
  let branchManagerRoleId;
  let maker;
  let checker;
  let branchManagerChecker;

  beforeAll(async () => {
    execFileSync('node', [path.join(__dirname, '../../src/db/migrate.js'), '--test'], {
      env: { ...process.env },
      stdio: 'inherit',
    });

    pool = new Pool({ connectionString });

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
    const { rows: bmRows } = await pool.query("SELECT id FROM roles WHERE name = 'branch_manager'");
    branchManagerRoleId = bmRows[0].id;

    maker = await createTestUser('compliance-maker@test.local');
    checker = await createTestUser('compliance-checker@test.local');
    // Migration 066 tiers loan.approve by amount: below GHS 100,000 requires
    // branch_manager/loan_officer, not the plain owner-role `checker` — every
    // test loan here disburses via takeLoanToDisbursed() at well under that
    // threshold, so it needs a decider actually holding that role.
    branchManagerChecker = await createTestUser('compliance-bm-checker@test.local', branchManagerRoleId);

    const branch = await branchService.createBranch(pool, { code: 'CMP-01', name: 'Compliance Test Branch', createdBy: maker });
    branchId = branch.id;
    glAccounts = branch.glAccounts;
  });

  afterAll(async () => {
    await pool.end();
  });

  async function createTestUser(email, roleId = ownerRoleId) {
    const { rows } = await pool.query(
      `INSERT INTO users (full_name, email, password_hash, role_id, home_branch_id)
       VALUES ($1, $1, 'x', $2, (SELECT id FROM branches WHERE code = 'HQ')) RETURNING id`,
      [email, roleId]
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
      ghanaCardNo: `GHA-9300000${String(ghanaCardSeq).padStart(2, '0')}-1`,
      createdBy: maker,
    });
    await customerService.updateKycStatus(pool, { customerId: customer.id, kycStatus: 'verified', actorId: maker });
    return customer;
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

  let productSeq = 0;
  async function createLoanProduct() {
    productSeq += 1;
    return loanService.createLoanProduct(pool, {
      name: `Compliance Product ${productSeq}`,
      code: `CMPP${productSeq}`,
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

  async function takeLoanToDisbursed({ product, customer, principalPesewas, termMonths, disbursementDate }) {
    const loan = await loanService.applyForLoan(pool, { customerId: customer.id, productId: product.id, principalPesewas, termMonths, appliedBy: maker });
    await loanService.submitAppraisal(pool, { loanId: loan.id, checklist: { verified: true }, recommendation: 'recommend', appraiserId: maker });
    const approval = await loanService.requestLoanApproval(pool, { loanId: loan.id, requestedBy: maker });
    // Migration 066: loan.approve below GHS 100,000 requires branch_manager/
    // loan_officer — every loan here is well under that, so `checker` (owner)
    // would not qualify.
    await decideAs(approval.id, branchManagerChecker);
    return loanService.disburseLoan(pool, { loanId: loan.id, disbursedBy: maker, disbursementDate });
  }

  // --- Loan classification -------------------------------------------------

  describe('loan classification', () => {
    test('createLoanClassificationConfigSet requires all five BOG categories', async () => {
      await expect(
        complianceService.createLoanClassificationConfigSet(pool, {
          categories: [{ category: 'current', minDaysPastDue: 0, maxDaysPastDue: 0, provisioningRateBps: 0 }],
          effectiveDate: '2026-01-01',
          createdBy: maker,
          actorBranchId: branchId,
        })
      ).rejects.toThrow(complianceService.ComplianceValidationError);
    });

    test('classifies loans against the active config and persists a queryable summary', async () => {
      await complianceService.createLoanClassificationConfigSet(pool, {
        categories: [
          { category: 'current', minDaysPastDue: 0, maxDaysPastDue: 0, provisioningRateBps: 0 },
          { category: 'olem', minDaysPastDue: 1, maxDaysPastDue: 30, provisioningRateBps: 500 },
          { category: 'substandard', minDaysPastDue: 31, maxDaysPastDue: 90, provisioningRateBps: 2500 },
          { category: 'doubtful', minDaysPastDue: 91, maxDaysPastDue: 180, provisioningRateBps: 5000 },
          { category: 'loss', minDaysPastDue: 181, maxDaysPastDue: null, provisioningRateBps: 10000 },
        ],
        effectiveDate: '2026-01-01',
        createdBy: maker,
        actorBranchId: branchId,
      });

      const product = await createLoanProduct();
      const currentCustomer = await createVerifiedCustomer('Current Loan Customer');
      await takeLoanToDisbursed({ product, customer: currentCustomer, principalPesewas: 200000, termMonths: 6, disbursementDate: '2026-06-01' });

      const lossCustomer = await createVerifiedCustomer('Loss Loan Customer');
      const lossLoan = await takeLoanToDisbursed({ product, customer: lossCustomer, principalPesewas: 400000, termMonths: 6, disbursementDate: '2025-01-01' });

      const asOfDate = '2026-06-15';
      const results = await complianceService.runLoanClassification(pool, { asOfDate, branchId, createdBy: maker });
      expect(results.length).toBeGreaterThanOrEqual(2);

      const lossRow = results.find((r) => Number(r.loan_id) === Number(lossLoan.id));
      expect(lossRow.category).toBe('loss');
      expect(Number(lossRow.provisioning_amount_pesewas)).toBe(400000);

      const summary = await complianceService.getLoanClassificationSummary(pool, { asOfDate, branchId });
      const lossCategory = summary.categories.find((c) => c.category === 'loss');
      expect(lossCategory.loanCount).toBeGreaterThanOrEqual(1);
      expect(lossCategory.provisioningPesewas).toBeGreaterThanOrEqual(400000);
      expect(summary.totalProvisioningPesewas).toBeGreaterThanOrEqual(400000);
    });

    test('classifyLoan throws when the active config has a gap', () => {
      const gappyConfig = [
        { category: 'current', min_days_past_due: 0, max_days_past_due: 0, provisioning_rate_bps: 0 },
        { category: 'loss', min_days_past_due: 100, max_days_past_due: null, provisioning_rate_bps: 10000 },
      ];
      expect(() => complianceService.classifyLoan(50, gappyConfig)).toThrow(complianceService.ComplianceValidationError);
    });

    test('getActiveLoanClassificationConfig 404s when nothing is configured yet for that date', async () => {
      await expect(complianceService.getActiveLoanClassificationConfig(pool, '2020-01-01')).rejects.toThrow(
        complianceService.ComplianceNotFoundError
      );
    });
  });

  // --- Regulatory ratios ----------------------------------------------------

  describe('regulatory ratio computation', () => {
    test('computes a ratio from configured GL codes without any hardcoded formula, and 404s if unconfigured', async () => {
      await expect(complianceService.getActiveRatioDefinition(pool, { name: 'unconfigured_ratio' })).rejects.toThrow(
        complianceService.ComplianceNotFoundError
      );

      // Dated safely before every other describe block's loan disbursement
      // in this file (earliest is 2025-01-01) so this test's ratio isn't
      // contaminated by other tests' cash-in-hand-moving activity sharing
      // the same branch — same cross-test-isolation lesson learned in
      // Module 9's own test suite.
      await glPosting.postJournalEntry(pool, {
        branchId,
        reference: `CMP-RATIO-${Date.now()}`,
        entryDate: '2024-06-01',
        sourceModule: 'manual_jv',
        createdBy: maker,
        lines: [
          { accountId: glAccounts.cashInHand.id, debitPesewas: 100000, branchId },
          { accountId: glAccounts.income.id, creditPesewas: 100000, branchId },
        ],
      });

      await complianceService.createRatioDefinition(pool, {
        name: 'test_ratio',
        numeratorGlCodes: [{ code: '1000' }],
        denominatorGlCodes: [{ code: '4000' }],
        effectiveDate: '2024-01-01',
        createdBy: maker,
      });

      const result = await complianceService.computeRatio(pool, { name: 'test_ratio', asOfDate: '2024-06-15', branchId });
      expect(result.numeratorPesewas).toBeGreaterThanOrEqual(100000);
      expect(result.denominatorPesewas).toBeGreaterThanOrEqual(100000);
      expect(result.compliant).toBeNull();

      await complianceService.createRatioDefinition(pool, {
        name: 'test_ratio',
        numeratorGlCodes: [{ code: '1000' }],
        denominatorGlCodes: [{ code: '4000' }],
        minimumRatioBps: 5000,
        effectiveDate: '2024-07-01',
        createdBy: maker,
      });
      const withMinimum = await complianceService.computeRatio(pool, { name: 'test_ratio', asOfDate: '2024-07-15', branchId });
      expect(typeof withMinimum.compliant).toBe('boolean');
    });
  });

  // --- GRA tax reporting -----------------------------------------------------

  describe('GRA tax reporting', () => {
    test('withholding tax summary sums investment_payouts paid in the period at the configured rate', async () => {
      await expect(
        complianceService.getWithholdingTaxSummary(pool, { periodStart: '2026-01-01', periodEnd: '2026-01-31' })
      ).rejects.toThrow(complianceService.ComplianceNotFoundError);

      await complianceService.createTaxRate(pool, {
        taxType: 'withholding_tax_investment_interest',
        rateBps: 800,
        effectiveDate: '2026-01-01',
        createdBy: maker,
      });

      const invCustomer = await createVerifiedCustomer('Investor Customer');
      const invProduct = await investmentService.createInvestmentProduct(pool, {
        name: 'Compliance Fixed Deposit',
        code: 'CMPFD',
        tenorMonths: 12,
        annualInterestRateBps: 1500,
        minPrincipalPesewas: 100000,
        payoutFrequency: 'monthly',
        createdBy: maker,
      });
      const { rows: invRows } = await pool.query(
        `INSERT INTO investments
           (customer_id, branch_id, product_id, principal_pesewas, tenor_months, annual_interest_rate_bps, payout_frequency, early_withdrawal_penalty_bps, applied_by, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active') RETURNING *`,
        [invCustomer.id, branchId, invProduct.id, 500000, 12, 1500, 'monthly', 0, maker]
      );
      const investment = invRows[0];
      await pool.query(
        `INSERT INTO investment_payouts (investment_id, amount_pesewas, threshold_flag, status, requested_by, updated_at)
         VALUES ($1, $2, false, 'paid', $3, '2026-02-10')`,
        [investment.id, 60000, maker]
      );

      const summary = await complianceService.getWithholdingTaxSummary(pool, { periodStart: '2026-02-01', periodEnd: '2026-02-28' });
      expect(summary.totalInterestPaidPesewas).toBe(60000);
      expect(summary.taxDuePesewas).toBe(Math.round((60000 * 800) / 10000));
    });

    test('VAT summary requires vatApplicableGlCodes to be configured, then sums the configured fee-income codes', async () => {
      await complianceService.createTaxRate(pool, {
        taxType: 'vat_fee_income',
        rateBps: 1250,
        effectiveDate: '2026-01-01',
        createdBy: maker,
      });
      await expect(
        complianceService.getVatSummary(pool, { periodStart: '2026-03-01', periodEnd: '2026-03-31' })
      ).rejects.toThrow(complianceService.ComplianceValidationError);

      await complianceService.createTaxRate(pool, {
        taxType: 'vat_fee_income',
        rateBps: 1250,
        vatApplicableGlCodes: ['4030'],
        effectiveDate: '2026-02-01',
        createdBy: maker,
      });

      await glPosting.postJournalEntry(pool, {
        branchId,
        reference: `CMP-VAT-${Date.now()}`,
        entryDate: '2026-03-10',
        sourceModule: 'manual_jv',
        createdBy: maker,
        lines: [
          { accountId: glAccounts.cashInHand.id, debitPesewas: 5000, branchId },
          { accountId: glAccounts.savingsFeeIncome.id, creditPesewas: 5000, branchId },
        ],
      });

      const vatSummary = await complianceService.getVatSummary(pool, { periodStart: '2026-03-01', periodEnd: '2026-03-31', branchId });
      expect(vatSummary.totalFeeIncomePesewas).toBe(5000);
      expect(vatSummary.vatDuePesewas).toBe(Math.round((5000 * 1250) / 10000));
    });
  });

  // --- Report templates + generation -----------------------------------------

  describe('report templates and generation', () => {
    test('creating a template with the same name increments the version and never mutates the prior version', async () => {
      const v1 = await complianceService.createReportTemplate(pool, {
        name: 'bog_quarterly_return',
        targetAuthority: 'Bank of Ghana',
        fieldMappings: { fields: [{ key: 'socialPerformance', source: 'social_performance_summary' }] },
        effectiveDate: '2026-01-01',
        createdBy: maker,
      });
      expect(v1.version).toBe(1);

      const v2 = await complianceService.createReportTemplate(pool, {
        name: 'bog_quarterly_return',
        targetAuthority: 'Bank of Ghana',
        fieldMappings: { fields: [{ key: 'socialPerformance', source: 'social_performance_summary' }, { key: 'par', source: 'loan_classification_summary' }] },
        effectiveDate: '2026-06-01',
        createdBy: maker,
      });
      expect(v2.version).toBe(2);

      const reloadedV1 = await complianceService.getReportTemplate(pool, v1.id);
      expect(reloadedV1.field_mappings.fields).toHaveLength(1);
    });

    test('generateReport populates every mapped field and snapshots it onto a new submission', async () => {
      const template = await complianceService.createReportTemplate(pool, {
        name: 'social_performance_only',
        targetAuthority: 'Donor Report',
        fieldMappings: { fields: [{ key: 'social', source: 'social_performance_summary' }] },
        effectiveDate: '2026-01-01',
        createdBy: maker,
      });

      const submission = await complianceService.generateReport(pool, {
        templateId: template.id,
        asOfDate: '2026-06-15',
        branchId,
        generatedBy: maker,
        actorBranchId: branchId,
      });
      expect(submission.status).toBe('generated');
      expect(submission.report_data.social).toBeDefined();
      expect(typeof submission.report_data.social.activeBorrowerCount).toBe('number');

      const submitted = await complianceService.markReportSubmitted(pool, {
        submissionId: submission.id,
        submittedBy: maker,
        fileReference: 'bog-submission-2026-06.pdf',
      });
      expect(submitted.status).toBe('submitted');

      await expect(
        complianceService.markReportSubmitted(pool, { submissionId: submission.id, submittedBy: maker, fileReference: 'again.pdf' })
      ).rejects.toThrow(complianceService.ComplianceConflictError);
    });

    test('generateReport rejects an unknown data source', async () => {
      const badTemplate = await complianceService.createReportTemplate(pool, {
        name: 'bad_template',
        targetAuthority: 'GRA',
        fieldMappings: { fields: [{ key: 'x', source: 'not_a_real_source' }] },
        effectiveDate: '2026-01-01',
        createdBy: maker,
      });
      await expect(
        complianceService.generateReport(pool, { templateId: badTemplate.id, generatedBy: maker, actorBranchId: branchId })
      ).rejects.toThrow(complianceService.ComplianceValidationError);
    });
  });

  // --- AML monitoring ---------------------------------------------------------

  describe('AML monitoring', () => {
    test('a screening run flags transactions at or above the threshold, never duplicates on rerun, and a flag never auto-clears', async () => {
      const rule = await complianceService.createAmlRule(pool, { name: 'Large savings movement', thresholdPesewas: 900000, createdBy: maker });

      const customer = await createVerifiedCustomer('AML Savings Customer');
      const product = await savingsService.createSavingsProduct(pool, { name: 'AML Savings', code: 'AMLSAV', createdBy: maker });
      const account = await savingsService.openAccount(pool, { customerId: customer.id, productId: product.id, createdBy: maker });
      // savings_transactions.created_at is always the real wall-clock
      // insert time (savingsService.deposit's `entryDate` only feeds the
      // GL journal entry's entry_date, not this column), so the
      // screening window below must bracket real "now", not a fixed
      // historical month.
      await savingsService.deposit(pool, { accountId: account.id, amountPesewas: 1000000, depositedBy: maker, entryDate: '2026-04-01' });

      const flagged = await complianceService.runAmlScreening(pool, { fromDate: '2020-01-01', toDate: '2030-12-31' });
      expect(flagged.some((f) => f.transaction_type === 'savings' && Number(f.amount_pesewas) === 1000000)).toBe(true);

      const rerun = await complianceService.runAmlScreening(pool, { fromDate: '2020-01-01', toDate: '2030-12-31' });
      expect(rerun.length).toBe(0);

      const openFlags = await complianceService.listAmlFlags(pool, { status: 'open', branchId });
      const flag = openFlags.find((f) => Number(f.rule_id) === Number(rule.id));
      expect(flag).toBeDefined();

      await expect(
        complianceService.reviewAmlFlag(pool, { flagId: flag.id, reviewedBy: maker, newStatus: 'reviewed' })
      ).rejects.toThrow(complianceService.ComplianceValidationError);

      const reviewed = await complianceService.reviewAmlFlag(pool, {
        flagId: flag.id,
        reviewedBy: maker,
        newStatus: 'reviewed',
        reviewNotes: 'Confirmed legitimate business deposit with customer.',
      });
      expect(reviewed.status).toBe('reviewed');

      const cleared = await complianceService.reviewAmlFlag(pool, {
        flagId: flag.id,
        reviewedBy: maker,
        newStatus: 'cleared',
        reviewNotes: 'Cleared after documentation review.',
      });
      expect(cleared.status).toBe('cleared');

      await expect(
        complianceService.reviewAmlFlag(pool, { flagId: flag.id, reviewedBy: maker, newStatus: 'reviewed', reviewNotes: 'again' })
      ).rejects.toThrow(complianceService.ComplianceConflictError);
    });

    test('a loan disbursement at or above the threshold is flagged under the loan_disbursement scope', async () => {
      await complianceService.createAmlRule(pool, { name: 'Large disbursement', thresholdPesewas: 1500000, transactionScope: 'loan_disbursement', createdBy: maker });
      const product = await createLoanProduct();
      const customer = await createVerifiedCustomer('AML Loan Customer');
      // loans.disbursed_at is always the real wall-clock disbursement time
      // (disbursementDate only feeds the GL entry/schedule dates), same
      // reasoning as the savings test above — bracket real "now".
      const loan = await takeLoanToDisbursed({ product, customer, principalPesewas: 2000000, termMonths: 12, disbursementDate: '2026-05-01' });

      const flagged = await complianceService.runAmlScreening(pool, { fromDate: '2020-01-01', toDate: '2030-12-31' });
      expect(flagged.some((f) => f.transaction_type === 'loan_disbursement' && Number(f.transaction_id) === Number(loan.id))).toBe(true);
    });
  });

  // --- Sanctions screening -----------------------------------------------------

  describe('sanctions screening', () => {
    test('an empty list always screens no_match, and a name match is a potential_match requiring human resolution', async () => {
      const cleanCustomer = await createVerifiedCustomer('Perfectly Ordinary Person');
      const cleanResult = await complianceService.screenCustomer(pool, { customerId: cleanCustomer.id, screenedBy: maker });
      expect(cleanResult.match_status).toBe('no_match');

      const flaggedCustomer = await createVerifiedCustomer('Notorious Test Match');
      await complianceService.addSanctionsListEntry(pool, { fullName: 'Notorious Test Match', listSource: 'test-fixture-list', addedBy: maker });

      const potentialMatch = await complianceService.screenCustomer(pool, { customerId: flaggedCustomer.id, screenedBy: maker });
      expect(potentialMatch.match_status).toBe('potential_match');

      const resolved = await complianceService.resolveScreeningMatch(pool, {
        screeningResultId: potentialMatch.id,
        resolvedBy: maker,
        resolution: 'cleared',
        notes: 'Confirmed different person via Ghana Card verification — false positive.',
      });
      expect(resolved.match_status).toBe('cleared');

      await expect(
        complianceService.resolveScreeningMatch(pool, { screeningResultId: potentialMatch.id, resolvedBy: maker, resolution: 'cleared', notes: 'again' })
      ).rejects.toThrow(complianceService.ComplianceConflictError);
    });

    test('runBatchScreening screens every active customer when no explicit list is given', async () => {
      const results = await complianceService.runBatchScreening(pool, { screenedBy: maker });
      expect(results.length).toBeGreaterThan(0);
    });
  });
});
