'use strict';

// Exercises Module 12 (systemAdminService.js + calendarService.js) against a
// real Postgres instance: the job registry (trigger by jobType/jobId, run
// history, a job-execution failure recorded rather than thrown), the
// working-calendar override round-trip, archive policies (eligibility is
// terminal-status + retention-age only — an open loan is never archived),
// backup trigger (a real pg_dump) + CSV export allowlist + restore's
// destructive-path guards (confirm flag, path-traversal rejection — never
// exercised against real data), subscription-licence expiry/reminder, and
// reminder-notification generation (repayment-due, susu-collection-due).
// Requires TEST_DATABASE_URL — see backend/README.md.

require('dotenv').config();
const { Pool } = require('pg');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const systemAdminService = require('../../src/modules/systemAdmin/systemAdminService');
const calendarService = require('../../src/modules/systemAdmin/calendarService');
const calendarMath = require('../../src/modules/systemAdmin/calendarMath');
const branchService = require('../../src/modules/branch/branchService');
const customerService = require('../../src/modules/customer/customerService');
const loanService = require('../../src/modules/loan/loanService');
const savingsService = require('../../src/modules/savings/savingsService');
const approvalWorkflow = require('../../src/shared/approvalWorkflow');

const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

const todayIso = () => new Date().toISOString().slice(0, 10);
const addDaysIso = (dateStr, days) => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

describeIfDb('Module 12: system administration', () => {
  let pool;
  let branchId;
  let ownerRoleId;
  let maker;
  let checker;

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

    maker = await createTestUser('sysadmin-maker@test.local');
    checker = await createTestUser('sysadmin-checker@test.local');

    const branch = await branchService.createBranch(pool, { code: 'SYS-01', name: 'System Admin Test Branch', createdBy: maker });
    branchId = branch.id;
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
      ghanaCardNo: `GHA-9400000${String(ghanaCardSeq).padStart(2, '0')}-1`,
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
      name: `SysAdmin Product ${productSeq}`,
      code: `SAP${productSeq}`,
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
    await decideAs(approval.id, checker);
    return loanService.disburseLoan(pool, { loanId: loan.id, disbursedBy: maker, disbursementDate });
  }

  let savingsProductSeq = 0;
  async function createSavingsProduct() {
    savingsProductSeq += 1;
    return savingsService.createSavingsProduct(pool, {
      name: `SysAdmin Savings ${savingsProductSeq}`,
      code: `SAS${savingsProductSeq}`,
      minBalancePesewas: 0,
      maintenanceFeePesewas: 0,
      withdrawalFeePesewas: 0,
      minBalanceChargePesewas: 0,
      withdrawalApprovalThresholdPesewas: 1000000,
      createdBy: maker,
    });
  }

  // --- Scheduled jobs / run history ------------------------------------------

  describe('scheduled jobs and run history', () => {
    test('createScheduledJob rejects an unknown jobType', async () => {
      await expect(
        systemAdminService.createScheduledJob(pool, { jobType: 'not_a_real_job', cronExpression: '0 1 * * *', runAsUserId: maker, createdBy: maker })
      ).rejects.toThrow(systemAdminService.SystemAdminValidationError);
    });

    test('createScheduledJob persists an active job, listScheduledJobs filters by status, updateScheduledJobStatus validates the enum', async () => {
      const job = await systemAdminService.createScheduledJob(pool, {
        jobType: 'standing_order_execution',
        cronExpression: '0 6 * * *',
        runAsUserId: maker,
        createdBy: maker,
      });
      expect(job.status).toBe('active');

      const active = await systemAdminService.listScheduledJobs(pool, { status: 'active' });
      expect(active.some((j) => Number(j.id) === Number(job.id))).toBe(true);

      await expect(
        systemAdminService.updateScheduledJobStatus(pool, { jobId: job.id, status: 'bogus', updatedBy: maker })
      ).rejects.toThrow(systemAdminService.SystemAdminValidationError);

      const paused = await systemAdminService.updateScheduledJobStatus(pool, { jobId: job.id, status: 'paused', updatedBy: maker });
      expect(paused.status).toBe('paused');

      await expect(
        systemAdminService.updateScheduledJobStatus(pool, { jobId: 999999, status: 'active', updatedBy: maker })
      ).rejects.toThrow(systemAdminService.SystemAdminNotFoundError);
    });

    test('triggerJob by jobType runs a registered job and records success in job_run_history', async () => {
      const result = await systemAdminService.triggerJob(pool, {
        jobType: 'standing_order_execution',
        triggeredBy: maker,
        params: { asOfDate: '2019-01-01' }, // safely before any standing order created elsewhere in this file
      });
      expect(result.status).toBe('success');
      expect(result.result.executed).toBe(0);

      const history = await systemAdminService.listJobRunHistory(pool, { jobType: 'standing_order_execution' });
      const run = history.find((h) => Number(h.id) === Number(result.runId));
      expect(run.status).toBe('success');
      expect(run.completed_at).not.toBeNull();
    });

    test('triggerJob by jobId also updates the scheduled_jobs bookkeeping columns', async () => {
      const job = await systemAdminService.createScheduledJob(pool, {
        jobType: 'agent_location_purge',
        cronExpression: '0 2 * * *',
        runAsUserId: maker,
        createdBy: maker,
      });

      const result = await systemAdminService.triggerJob(pool, { jobId: job.id, triggeredBy: maker });
      expect(result.status).toBe('success');

      const [refreshed] = await systemAdminService.listScheduledJobs(pool, {});
      const match = (await systemAdminService.listScheduledJobs(pool, {})).find((j) => Number(j.id) === Number(job.id));
      expect(match.last_status).toBe('success');
      expect(match.last_run_at).not.toBeNull();
    });

    test('triggerJob throws immediately on an unknown jobId or jobType, without creating a run row', async () => {
      const before = await systemAdminService.listJobRunHistory(pool, {});

      await expect(systemAdminService.triggerJob(pool, { jobId: 999999, triggeredBy: maker })).rejects.toThrow(
        systemAdminService.SystemAdminNotFoundError
      );
      await expect(systemAdminService.triggerJob(pool, { jobType: 'not_a_real_job', triggeredBy: maker })).rejects.toThrow(
        systemAdminService.SystemAdminValidationError
      );

      const after = await systemAdminService.listJobRunHistory(pool, {});
      expect(after.length).toBe(before.length);
    });

    test('a job-execution failure is recorded in job_run_history and returned as status "failed", never thrown', async () => {
      // A malformed daysAhead breaks the job's own `(daysAhead || ' days')::interval`
      // cast at the database level — a genuine runtime failure inside the
      // job body, not a caller mistake about jobId/jobType, so triggerJob
      // must catch it, not propagate it.
      const result = await systemAdminService.triggerJob(pool, {
        jobType: 'repayment_due_reminders',
        triggeredBy: maker,
        params: { daysAhead: 'not-a-number' },
      });
      expect(result.status).toBe('failed');
      expect(result.error).toBeTruthy();

      const history = await systemAdminService.listJobRunHistory(pool, { status: 'failed' });
      const run = history.find((h) => Number(h.id) === Number(result.runId));
      expect(run.status).toBe('failed');
      expect(run.error_message).toBeTruthy();
    });

    test('listJobRunHistory filters by fromDate/toDate', async () => {
      const all = await systemAdminService.listJobRunHistory(pool, {});
      expect(all.length).toBeGreaterThan(0);
      const future = await systemAdminService.listJobRunHistory(pool, { fromDate: '2099-01-01' });
      expect(future.length).toBe(0);
    });
  });

  // --- Working calendar --------------------------------------------------------

  describe('working calendar', () => {
    test('upsertWorkingCalendarDay requires actorBranchId', async () => {
      await expect(
        calendarService.upsertWorkingCalendarDay(pool, { date: '2026-08-01', isWorkingDay: false, createdBy: maker })
      ).rejects.toThrow(calendarService.CalendarValidationError);
    });

    test('an explicit override marks a weekday as a holiday and a weekend as working, overriding the Sat/Sun default', async () => {
      // 2026-08-03 is a Monday; 2026-08-08 is a Saturday.
      await calendarService.upsertWorkingCalendarDay(pool, {
        date: '2026-08-03',
        isWorkingDay: false,
        holidayName: 'Test Public Holiday',
        createdBy: maker,
        actorBranchId: branchId,
      });
      await calendarService.upsertWorkingCalendarDay(pool, {
        date: '2026-08-08',
        isWorkingDay: true,
        createdBy: maker,
        actorBranchId: branchId,
      });

      const overrides = await calendarService.getWorkingCalendarOverrides(pool, { fromDate: '2026-08-01', toDate: '2026-08-10' });
      expect(overrides.get('2026-08-03')).toBe(false);
      expect(overrides.get('2026-08-08')).toBe(true);

      // Round-tripped through calendarMath exactly as loanService/standingOrderService use it.
      expect(calendarMath.rollForwardToWorkingDay('2026-08-03', overrides)).toBe('2026-08-04');
      expect(calendarMath.rollForwardToWorkingDay('2026-08-08', overrides)).toBe('2026-08-08');
      // Without the override, the same Saturday would roll forward to Monday.
      expect(calendarMath.rollForwardToWorkingDay('2026-08-08', new Map())).toBe('2026-08-10');

      const listed = await calendarService.listWorkingCalendar(pool, { fromDate: '2026-08-01', toDate: '2026-08-10' });
      expect(listed.some((d) => calendarService.toDateString(d.calendar_date) === '2026-08-03' && d.holiday_name === 'Test Public Holiday')).toBe(true);
    });

    test('re-upserting the same date updates it in place rather than duplicating', async () => {
      await calendarService.upsertWorkingCalendarDay(pool, { date: '2026-09-01', isWorkingDay: false, holidayName: 'First', createdBy: maker, actorBranchId: branchId });
      await calendarService.upsertWorkingCalendarDay(pool, { date: '2026-09-01', isWorkingDay: false, holidayName: 'Renamed', createdBy: maker, actorBranchId: branchId });
      const listed = await calendarService.listWorkingCalendar(pool, { fromDate: '2026-09-01', toDate: '2026-09-01' });
      expect(listed.length).toBe(1);
      expect(listed[0].holiday_name).toBe('Renamed');
    });
  });

  // --- Archive policies ---------------------------------------------------------

  describe('archive policies', () => {
    // archive_policies has UNIQUE(entity_type) — the module intentionally
    // allows only one active policy per entity type at a time — so these
    // two policies are created once and reused across the tests below
    // rather than one-per-test.
    let loanPolicy;
    let savingsPolicy;

    beforeAll(async () => {
      loanPolicy = await systemAdminService.createArchivePolicy(pool, {
        entityType: 'closed_loans',
        retentionPeriodDays: 30,
        archiveLocation: 'local:/archive/loans',
        createdBy: maker,
      });
      savingsPolicy = await systemAdminService.createArchivePolicy(pool, {
        entityType: 'closed_savings_accounts',
        retentionPeriodDays: 30,
        archiveLocation: 'local:/archive/savings',
        createdBy: maker,
      });
    });

    test('createArchivePolicy rejects an unknown entityType', async () => {
      await expect(
        systemAdminService.createArchivePolicy(pool, { entityType: 'not_a_real_entity', retentionPeriodDays: 30, archiveLocation: 's3://x', createdBy: maker })
      ).rejects.toThrow(systemAdminService.SystemAdminValidationError);
    });

    test('never archives a record that is still open (wrong status) or too recent (inside the retention window)', async () => {
      const policy = loanPolicy;

      const product = await createLoanProduct();

      // Open (disbursed, not written off) loan — must never be archived regardless of age.
      const openCustomer = await createVerifiedCustomer('Open Loan Customer');
      const openLoan = await takeLoanToDisbursed({ product, customer: openCustomer, principalPesewas: 100000, termMonths: 6, disbursementDate: '2020-01-01' });
      await pool.query("UPDATE loans SET updated_at = now() - interval '999 days' WHERE id = $1", [openLoan.id]);

      // Written-off loan, but too recently for the 30-day retention window.
      const recentCustomer = await createVerifiedCustomer('Recently Written-off Customer');
      const recentLoan = await takeLoanToDisbursed({ product, customer: recentCustomer, principalPesewas: 150000, termMonths: 6, disbursementDate: '2020-02-01' });
      await loanService.writeOffLoan(pool, { loanId: recentLoan.id, reason: 'test - too recent', writtenOffBy: maker });

      const firstRun = await systemAdminService.runArchivePolicy(pool, { policyId: policy.id, triggeredBy: maker });
      expect(firstRun.ids).not.toContain(Number(openLoan.id));
      expect(firstRun.ids).not.toContain(Number(recentLoan.id));

      const openAfter = await loanService.getLoan(pool, openLoan.id);
      expect(openAfter.archived_at).toBeNull();
    });

    test('archives an eligible written-off loan exactly once and logs it to archived_records', async () => {
      const policy = loanPolicy;

      const product = await createLoanProduct();
      const customer = await createVerifiedCustomer('Eligible Written-off Customer');
      const loan = await takeLoanToDisbursed({ product, customer, principalPesewas: 200000, termMonths: 6, disbursementDate: '2020-03-01' });
      await loanService.writeOffLoan(pool, { loanId: loan.id, reason: 'test - archive eligible', writtenOffBy: maker });
      await pool.query("UPDATE loans SET updated_at = now() - interval '999 days' WHERE id = $1", [loan.id]);

      const result = await systemAdminService.runArchivePolicy(pool, { policyId: policy.id, triggeredBy: maker });
      expect(result.ids).toContain(Number(loan.id));

      const archived = await loanService.getLoan(pool, loan.id);
      expect(archived.archived_at).not.toBeNull();

      const records = await systemAdminService.listArchivedRecords(pool, { entityType: 'closed_loans' });
      expect(records.some((r) => Number(r.entity_id) === Number(loan.id))).toBe(true);

      // Running again must not re-archive (idempotent — already archived_at IS NOT NULL is excluded).
      const secondRun = await systemAdminService.runArchivePolicy(pool, { policyId: policy.id, triggeredBy: maker });
      expect(secondRun.ids).not.toContain(Number(loan.id));
    });

    test('archives an eligible closed savings account', async () => {
      const policy = savingsPolicy;

      const savingsProduct = await createSavingsProduct();
      const customer = await createVerifiedCustomer('Closed Savings Customer');
      const account = await savingsService.openAccount(pool, { customerId: customer.id, productId: savingsProduct.id, createdBy: maker });
      await savingsService.closeAccount(pool, { accountId: account.id, closedBy: maker, reason: 'test' });
      await pool.query("UPDATE savings_accounts SET updated_at = now() - interval '999 days' WHERE id = $1", [account.id]);

      const result = await systemAdminService.runArchivePolicy(pool, { policyId: policy.id, triggeredBy: maker });
      expect(result.ids).toContain(Number(account.id));

      const archived = await savingsService.getAccount(pool, account.id);
      expect(archived.archived_at).not.toBeNull();
    });

    test('runArchivePolicy 404s on an unknown policy and rejects running a paused policy', async () => {
      await expect(systemAdminService.runArchivePolicy(pool, { policyId: 999999, triggeredBy: maker })).rejects.toThrow(
        systemAdminService.SystemAdminNotFoundError
      );

      // Reuses savingsPolicy (UNIQUE(entity_type) forbids a second
      // closed_savings_accounts policy) — deactivated here, then restored
      // to active since it's shared with the other tests in this describe.
      await pool.query("UPDATE archive_policies SET status = 'inactive' WHERE id = $1", [savingsPolicy.id]);
      await expect(systemAdminService.runArchivePolicy(pool, { policyId: savingsPolicy.id, triggeredBy: maker })).rejects.toThrow(
        systemAdminService.SystemAdminConflictError
      );
      await pool.query("UPDATE archive_policies SET status = 'active' WHERE id = $1", [savingsPolicy.id]);
    });
  });

  // --- Backups / restore / CSV export --------------------------------------------

  describe('backups, restore guards, and CSV export', () => {
    test('triggerBackup runs a real pg_dump and records a success row with a file on disk', async () => {
      const run = await systemAdminService.triggerBackup(pool, { triggeredBy: maker });
      expect(run.status).toBe('success');
      expect(run.file_path).toBeTruthy();
      expect(fs.existsSync(run.file_path)).toBe(true);
      expect(Number(run.file_size_bytes)).toBeGreaterThan(0);

      fs.unlinkSync(run.file_path);

      const runs = await systemAdminService.listBackupRuns(pool, { status: 'success' });
      expect(runs.some((r) => Number(r.id) === Number(run.id))).toBe(true);
    }, 30000);

    test('triggerRestore refuses without an explicit confirm:true, and rejects filePath that escapes the backup directory', async () => {
      await expect(
        systemAdminService.triggerRestore(pool, { filePath: 'whatever.sql', triggeredBy: maker, actorBranchId: branchId, confirm: false })
      ).rejects.toThrow(systemAdminService.SystemAdminValidationError);

      await expect(
        systemAdminService.triggerRestore(pool, { filePath: '../../../etc/passwd', triggeredBy: maker, actorBranchId: branchId, confirm: true })
      ).rejects.toThrow(systemAdminService.SystemAdminValidationError);

      // Confirmed, path-safe, but the file simply doesn't exist — verifies the
      // existence check is reached without ever invoking the destructive psql
      // command against real data (never exercised live in this test suite).
      await expect(
        systemAdminService.triggerRestore(pool, { filePath: 'does-not-exist.sql', triggeredBy: maker, actorBranchId: branchId, confirm: true })
      ).rejects.toThrow(systemAdminService.SystemAdminNotFoundError);
    });

    test('exportTableToCsv rejects tables outside the allowlist and exports a header + rows for an allowed table', async () => {
      await expect(systemAdminService.exportTableToCsv(pool, { tableName: 'users' })).rejects.toThrow(
        systemAdminService.SystemAdminValidationError
      );

      const csv = await systemAdminService.exportTableToCsv(pool, { tableName: 'branches' });
      const lines = csv.split('\n');
      expect(lines[0].split(',')).toContain('code');
      expect(lines.length).toBeGreaterThan(1);
    });
  });

  // --- Subscription / licence tracking ------------------------------------------

  describe('subscription licences', () => {
    test('createSubscriptionLicence validates required fields', async () => {
      await expect(
        systemAdminService.createSubscriptionLicence(pool, { tenantName: 'Acme', plan: 'pro', createdBy: maker })
      ).rejects.toThrow(systemAdminService.SystemAdminValidationError);
    });

    test('subscription_expiry_check job sends a reminder for a soon-to-expire licence and expires a past-due one', async () => {
      const past = addDaysIso(todayIso(), -1);
      const nearFuture = addDaysIso(todayIso(), 5);
      const farFuture = addDaysIso(todayIso(), 400);

      const expiring = await systemAdminService.createSubscriptionLicence(pool, {
        tenantName: 'Expiring Tenant', plan: 'standard', seats: 5, startDate: '2025-01-01', endDate: past, createdBy: maker,
      });
      const soon = await systemAdminService.createSubscriptionLicence(pool, {
        tenantName: 'Soon Tenant', plan: 'standard', seats: 5, startDate: '2025-01-01', endDate: nearFuture, createdBy: maker,
      });
      const healthy = await systemAdminService.createSubscriptionLicence(pool, {
        tenantName: 'Healthy Tenant', plan: 'standard', seats: 5, startDate: '2025-01-01', endDate: farFuture, createdBy: maker,
      });

      const result = await systemAdminService.triggerJob(pool, {
        jobType: 'subscription_expiry_check',
        triggeredBy: maker,
        params: { daysAhead: 30 },
      });
      expect(result.status).toBe('success');
      expect(result.result.expiredCount).toBeGreaterThanOrEqual(1);
      expect(result.result.remindedCount).toBeGreaterThanOrEqual(1);

      const licences = await systemAdminService.listSubscriptionLicences(pool, {});
      const expiringAfter = licences.find((l) => Number(l.id) === Number(expiring.id));
      const soonAfter = licences.find((l) => Number(l.id) === Number(soon.id));
      const healthyAfter = licences.find((l) => Number(l.id) === Number(healthy.id));

      expect(expiringAfter.status).toBe('expired');
      expect(soonAfter.status).toBe('active');
      expect(soonAfter.renewal_reminder_sent_at).not.toBeNull();
      expect(healthyAfter.renewal_reminder_sent_at).toBeNull();
    });
  });

  // --- Reminder notifications ----------------------------------------------------

  describe('reminder notifications', () => {
    test('repayment_due_reminders creates one reminder per due installment and is idempotent on re-run', async () => {
      const product = await createLoanProduct();
      const customer = await createVerifiedCustomer('Reminder Loan Customer');
      const loan = await takeLoanToDisbursed({ product, customer, principalPesewas: 300000, termMonths: 6, disbursementDate: '2026-01-01' });

      const schedule = await loanService.getLoanSchedule(pool, { loanId: loan.id });
      const firstDueDate = calendarService.toDateString(schedule[0].due_date);

      const result = await systemAdminService.triggerJob(pool, {
        jobType: 'repayment_due_reminders',
        triggeredBy: maker,
        params: { asOfDate: firstDueDate, daysAhead: 0 },
      });
      expect(result.status).toBe('success');
      expect(result.result.createdCount).toBeGreaterThanOrEqual(1);

      const reminders = await systemAdminService.listReminderNotifications(pool, { notificationType: 'repayment_due', customerId: customer.id });
      expect(reminders.length).toBeGreaterThanOrEqual(1);

      const again = await systemAdminService.triggerJob(pool, {
        jobType: 'repayment_due_reminders',
        triggeredBy: maker,
        params: { asOfDate: firstDueDate, daysAhead: 0 },
      });
      expect(again.result.createdCount).toBe(0);
    });

    test('susu_collection_due_reminders creates a reminder for an active, short-of-target cycle nearing its end date', async () => {
      const customer = await createVerifiedCustomer('Susu Reminder Customer');
      const cycleEndDate = addDaysIso(todayIso(), 2);
      const { rows } = await pool.query(
        `INSERT INTO susu_accounts
           (account_no, customer_id, branch_id, cycle_length_days, expected_collection_pesewas, target_amount_pesewas, collected_pesewas, cycle_start_date, cycle_end_date, created_by)
         VALUES ($1, $2, $3, 30, 1000, 30000, 5000, $4, $5, $6) RETURNING id`,
        [`SUSU-SYS-${Date.now()}`, customer.id, branchId, addDaysIso(todayIso(), -28), cycleEndDate, maker]
      );
      const susuAccountId = rows[0].id;

      const result = await systemAdminService.triggerJob(pool, {
        jobType: 'susu_collection_due_reminders',
        triggeredBy: maker,
        params: { asOfDate: todayIso(), daysAhead: 3 },
      });
      expect(result.status).toBe('success');
      expect(result.result.createdCount).toBeGreaterThanOrEqual(1);

      const reminders = await systemAdminService.listReminderNotifications(pool, { notificationType: 'susu_collection_due', customerId: customer.id });
      const match = reminders.find((r) => Number(r.entity_id) === Number(susuAccountId));
      expect(match).toBeTruthy();
      expect(match.status).toBe('pending');
    });

    test('markNotificationSent / markNotificationFailed transition status and 404 on an unknown id', async () => {
      const customer = await createVerifiedCustomer('Notification Lifecycle Customer');
      const { rows } = await pool.query(
        `INSERT INTO reminder_notifications (notification_type, entity_type, entity_id, customer_id, due_date, message)
         VALUES ('repayment_due', 'loan_schedule', 999999, $1, $2, 'test') RETURNING *`,
        [customer.id, todayIso()]
      );
      const notification = rows[0];

      const sent = await systemAdminService.markNotificationSent(pool, { notificationId: notification.id });
      expect(sent.status).toBe('sent');
      expect(sent.sent_at).not.toBeNull();

      const { rows: rows2 } = await pool.query(
        `INSERT INTO reminder_notifications (notification_type, entity_type, entity_id, customer_id, due_date, message)
         VALUES ('repayment_due', 'loan_schedule', 999998, $1, $2, 'test') RETURNING *`,
        [customer.id, todayIso()]
      );
      const failed = await systemAdminService.markNotificationFailed(pool, { notificationId: rows2[0].id });
      expect(failed.status).toBe('failed');

      await expect(systemAdminService.markNotificationSent(pool, { notificationId: 999999 })).rejects.toThrow(
        systemAdminService.SystemAdminNotFoundError
      );
    });
  });
});
