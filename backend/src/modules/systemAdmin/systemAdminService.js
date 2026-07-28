'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const execFileAsync = promisify(execFile);

const auditLog = require('../../shared/auditLog');
const branchService = require('../branch/branchService');
const loanService = require('../loan/loanService');
const investmentService = require('../investment/investmentService');
const cashierService = require('../cashier/cashierService');
const standingOrderService = require('../savings/standingOrderService');
const agentService = require('../agent/agentService');
const calendarService = require('./calendarService');

/**
 * Module 12: System Administration. Per the module prompt's own "BEFORE
 * YOU WRITE CODE" instruction, this file owns SCHEDULING
 * infrastructure, never the financial calculations that run on a
 * schedule — every JOB_REGISTRY entry below is a thin wrapper calling an
 * EXISTING function in the module that actually owns that business logic
 * (loanService.accrueOverdraftInterest, investmentService.accrueInterest,
 * cashierService.closeOutPeriod, standingOrderService.executeDueOrders,
 * agentService.purgeOldLocations).
 *
 * IMPORTANT: this module does NOT start a live, automatically-firing
 * cron process. `scheduled_jobs`/`cron_expression`/`next_run_at` are
 * configuration/bookkeeping for when a real scheduler daemon is wired up
 * — running one would be a background process outside the ordinary
 * request/response cycle (and, if this app is ever scaled to multiple
 * instances, would need its own leader-election/locking to avoid
 * duplicate firing), which is a bigger architectural decision than
 * "start Module 12" implies. Every job in this session is actually
 * invoked via `triggerJob` — either a real admin's manual click, or
 * (eventually) a real scheduler calling the exact same function. See
 * Decisions_Log.md.
 */

class SystemAdminValidationError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 400;
  }
}
class SystemAdminNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 404;
  }
}
class SystemAdminConflictError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 409;
  }
}

const todayIso = () => new Date().toISOString().slice(0, 10);

// --- Job registry --------------------------------------------------------------

async function runOverdraftInterestAccrualJob(pool, { actingAs, accrualDate = todayIso(), days = 30 }) {
  const loans = await loanService.listLoans(pool, { status: 'disbursed' });
  const overdrafts = loans.filter((l) => l.loan_type === 'overdraft');
  const results = [];
  for (const loan of overdrafts) {
    try {
      const result = await loanService.accrueOverdraftInterest(pool, { loanId: loan.id, accrualDate, days, accruedBy: actingAs });
      results.push({ loanId: Number(loan.id), ok: true, ...result });
    } catch (err) {
      results.push({ loanId: Number(loan.id), ok: false, error: err.message });
    }
  }
  return { processedCount: results.length, succeededCount: results.filter((r) => r.ok).length, failedCount: results.filter((r) => !r.ok).length, results };
}

async function runInvestmentInterestAccrualJob(pool, { actingAs, accrualDate = todayIso(), days = 30 }) {
  const investments = await investmentService.listInvestments(pool, { status: 'active' });
  const results = [];
  for (const investment of investments) {
    try {
      const result = await investmentService.accrueInterest(pool, { investmentId: investment.id, accrualDate, days, accruedBy: actingAs });
      results.push({ investmentId: Number(investment.id), ok: true, ...result });
    } catch (err) {
      results.push({ investmentId: Number(investment.id), ok: false, error: err.message });
    }
  }
  return { processedCount: results.length, succeededCount: results.filter((r) => r.ok).length, failedCount: results.filter((r) => !r.ok).length, results };
}

/** Runs a 'day' close-out for every branch for the given date, skipping (and recording, not aborting on) branches with open tills or an existing close-out. */
async function runCashierDayCloseJob(pool, { actingAs, businessDate = todayIso() }) {
  const branches = await branchService.listBranches(pool, {});
  const results = [];
  for (const branch of branches) {
    try {
      const snapshot = await cashierService.closeOutPeriod(pool, {
        branchId: branch.id,
        periodType: 'day',
        periodStart: businessDate,
        periodEnd: businessDate,
        closedBy: actingAs,
      });
      results.push({ branchId: Number(branch.id), ok: true, snapshotId: snapshot.id });
    } catch (err) {
      results.push({ branchId: Number(branch.id), ok: false, error: err.message });
    }
  }
  return { processedCount: results.length, succeededCount: results.filter((r) => r.ok).length, failedCount: results.filter((r) => !r.ok).length, results };
}

async function runStandingOrderExecutionJob(pool, { actingAs, asOfDate = todayIso() }) {
  return standingOrderService.executeDueOrders(pool, { asOfDate, executedBy: actingAs });
}

/**
 * loanService.resetFloatingRateProducts needs a branchId to stamp its
 * audit log entries with (policy rates/loan products aren't themselves
 * branch-scoped — see policyRateService.js's own comment on the same
 * convention), which no other job wrapper here has needed to resolve
 * before: the acting user's own home branch, same as every other
 * "global entity, audited anyway" mutation in this codebase (rbac.js's
 * role/permission routes, policyRateService.updatePolicyRateValue).
 */
async function runLoanFloatingRateResetJob(pool, { actingAs, asOfDate = todayIso() }) {
  const { rows } = await pool.query('SELECT home_branch_id FROM users WHERE id = $1', [actingAs]);
  if (!rows[0]) throw new SystemAdminValidationError(`user ${actingAs} not found`);
  return loanService.resetFloatingRateProducts(pool, { asOfDate, resetBy: actingAs, actorBranchId: rows[0].home_branch_id });
}

async function runAgentLocationPurgeJob(pool, { olderThanDays } = {}) {
  return agentService.purgeOldLocations(pool, { olderThanDays });
}

async function runArchiveSweepJob(pool, { actingAs }) {
  const policies = await listArchivePolicies(pool, { status: 'active' });
  const results = [];
  for (const policy of policies) {
    try {
      results.push(await runArchivePolicy(pool, { policyId: policy.id, triggeredBy: actingAs }));
    } catch (err) {
      results.push({ entityType: policy.entity_type, ok: false, error: err.message });
    }
  }
  return { policiesRun: results.length, results };
}

async function runSubscriptionExpiryCheckJob(pool, { daysAhead = 30 } = {}) {
  const { rows: reminded } = await pool.query(
    `UPDATE subscription_licences
        SET renewal_reminder_sent_at = now()
      WHERE status = 'active' AND renewal_reminder_sent_at IS NULL
        AND end_date <= current_date + ($1 || ' days')::interval
      RETURNING id`,
    [daysAhead]
  );
  const { rows: expired } = await pool.query(
    `UPDATE subscription_licences SET status = 'expired', updated_at = now()
      WHERE status = 'active' AND end_date < current_date
      RETURNING id`
  );
  return { remindedCount: reminded.length, expiredCount: expired.length };
}

async function runRepaymentDueRemindersJob(pool, { asOfDate = todayIso(), daysAhead = 3 } = {}) {
  const { rows } = await pool.query(
    `SELECT ls.id, ls.due_date, l.customer_id
       FROM loan_schedules ls
       JOIN loans l ON l.id = ls.loan_id AND ls.schedule_version = l.current_schedule_version
      WHERE l.status = 'disbursed'
        AND ls.due_date >= $1 AND ls.due_date <= $1::date + ($2 || ' days')::interval
        AND (ls.principal_due_pesewas + ls.interest_due_pesewas + ls.fees_due_pesewas)
          > (ls.principal_paid_pesewas + ls.interest_paid_pesewas + ls.fees_paid_pesewas)`,
    [asOfDate, daysAhead]
  );
  let createdCount = 0;
  for (const row of rows) {
    const dueDate = calendarService.toDateString(row.due_date);
    const { rowCount } = await pool.query(
      `INSERT INTO reminder_notifications (notification_type, entity_type, entity_id, customer_id, due_date, message)
       VALUES ('repayment_due', 'loan_schedule', $1, $2, $3, $4)
       ON CONFLICT (notification_type, entity_type, entity_id, due_date) DO NOTHING`,
      [row.id, row.customer_id, dueDate, `Loan repayment due ${dueDate}`]
    );
    createdCount += rowCount;
  }
  return { candidateCount: rows.length, createdCount };
}

async function runSusuCollectionDueRemindersJob(pool, { asOfDate = todayIso(), daysAhead = 3 } = {}) {
  const { rows } = await pool.query(
    `SELECT id, customer_id, cycle_end_date FROM susu_accounts
      WHERE status = 'active' AND collected_pesewas < target_amount_pesewas
        AND cycle_end_date >= $1 AND cycle_end_date <= $1::date + ($2 || ' days')::interval`,
    [asOfDate, daysAhead]
  );
  let createdCount = 0;
  for (const row of rows) {
    const dueDate = calendarService.toDateString(row.cycle_end_date);
    const { rowCount } = await pool.query(
      `INSERT INTO reminder_notifications (notification_type, entity_type, entity_id, customer_id, due_date, message)
       VALUES ('susu_collection_due', 'susu_account', $1, $2, $3, $4)
       ON CONFLICT (notification_type, entity_type, entity_id, due_date) DO NOTHING`,
      [row.id, row.customer_id, dueDate, `Susu cycle ${row.id} ends ${dueDate} and is short of its target`]
    );
    createdCount += rowCount;
  }
  return { candidateCount: rows.length, createdCount };
}

const JOB_REGISTRY = {
  loan_overdraft_interest_accrual: runOverdraftInterestAccrualJob,
  loan_floating_rate_reset: runLoanFloatingRateResetJob,
  investment_interest_accrual: runInvestmentInterestAccrualJob,
  cashier_day_close: runCashierDayCloseJob,
  standing_order_execution: runStandingOrderExecutionJob,
  agent_location_purge: runAgentLocationPurgeJob,
  archive_sweep: runArchiveSweepJob,
  subscription_expiry_check: runSubscriptionExpiryCheckJob,
  repayment_due_reminders: runRepaymentDueRemindersJob,
  susu_collection_due_reminders: runSusuCollectionDueRemindersJob,
};

async function createScheduledJob(pool, { jobType, cronExpression, runAsUserId, createdBy }) {
  if (!JOB_REGISTRY[jobType]) {
    throw new SystemAdminValidationError(`jobType must be one of ${Object.keys(JOB_REGISTRY).join(', ')}`);
  }
  if (!cronExpression || !runAsUserId || !createdBy) {
    throw new SystemAdminValidationError('cronExpression, runAsUserId, and createdBy are required');
  }
  const { rows } = await pool.query(
    `INSERT INTO scheduled_jobs (job_type, cron_expression, run_as_user_id, created_by)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [jobType, cronExpression, runAsUserId, createdBy]
  );
  return rows[0];
}

async function listScheduledJobs(pool, { status } = {}) {
  const params = [];
  let where = '';
  if (status) {
    params.push(status);
    where = 'WHERE status = $1';
  }
  const { rows } = await pool.query(`SELECT * FROM scheduled_jobs ${where} ORDER BY id`, params);
  return rows;
}

async function updateScheduledJobStatus(pool, { jobId, status, updatedBy }) {
  if (!['active', 'paused'].includes(status)) throw new SystemAdminValidationError("status must be 'active' or 'paused'");
  const { rows } = await pool.query(
    'UPDATE scheduled_jobs SET status = $1, updated_at = now() WHERE id = $2 RETURNING *',
    [status, jobId]
  );
  if (!rows[0]) throw new SystemAdminNotFoundError(`scheduled_job ${jobId} not found`);
  return rows[0];
}

/**
 * The one entry point every job run goes through, scheduled or manual.
 * A job-EXECUTION failure is captured into job_run_history and returned
 * as `{ status: 'failed', error }` rather than thrown — "must never fail
 * silently" (module prompt's own rule) means the failure is always
 * recorded and visible in the response, not that it crashes the caller.
 * A caller MISTAKE (unknown jobId/jobType) still throws immediately,
 * before any run row is even created.
 */
async function triggerJob(pool, { jobId = null, jobType = null, triggeredBy, params = {} }) {
  if (!triggeredBy) throw new SystemAdminValidationError('triggeredBy is required');

  let resolvedJobType = jobType;
  if (jobId) {
    const { rows } = await pool.query('SELECT * FROM scheduled_jobs WHERE id = $1', [jobId]);
    if (!rows[0]) throw new SystemAdminNotFoundError(`scheduled_job ${jobId} not found`);
    resolvedJobType = rows[0].job_type;
  }
  const jobFn = JOB_REGISTRY[resolvedJobType];
  if (!jobFn) throw new SystemAdminValidationError(`unknown jobType '${resolvedJobType}'`);

  const { rows: runRows } = await pool.query(
    `INSERT INTO job_run_history (scheduled_job_id, job_type, triggered_by) VALUES ($1, $2, $3) RETURNING *`,
    [jobId, resolvedJobType, triggeredBy]
  );
  const run = runRows[0];

  try {
    const result = await jobFn(pool, { ...params, actingAs: triggeredBy });
    await pool.query(
      `UPDATE job_run_history SET completed_at = now(), status = 'success', result_summary = $1 WHERE id = $2`,
      [JSON.stringify(result), run.id]
    );
    if (jobId) {
      await pool.query(`UPDATE scheduled_jobs SET last_run_at = now(), last_status = 'success', updated_at = now() WHERE id = $1`, [jobId]);
    }
    return { runId: run.id, jobType: resolvedJobType, status: 'success', result };
  } catch (err) {
    await pool.query(
      `UPDATE job_run_history SET completed_at = now(), status = 'failed', error_message = $1 WHERE id = $2`,
      [err.message, run.id]
    );
    if (jobId) {
      await pool.query(`UPDATE scheduled_jobs SET last_run_at = now(), last_status = 'failed', updated_at = now() WHERE id = $1`, [jobId]);
    }
    return { runId: run.id, jobType: resolvedJobType, status: 'failed', error: err.message };
  }
}

async function listJobRunHistory(pool, { jobType, status, fromDate, toDate } = {}) {
  const clauses = [];
  const params = [];
  const add = (col, val) => {
    if (val === undefined || val === null) return;
    params.push(val);
    clauses.push(`${col} = $${params.length}`);
  };
  add('job_type', jobType);
  add('status', status);
  if (fromDate) {
    params.push(fromDate);
    clauses.push(`started_at >= $${params.length}`);
  }
  if (toDate) {
    params.push(toDate);
    clauses.push(`started_at <= $${params.length}`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await pool.query(`SELECT * FROM job_run_history ${where} ORDER BY started_at DESC`, params);
  return rows;
}

// --- Archive policies ------------------------------------------------------------

/**
 * Which live table/statuses count as "eligible to archive" for each
 * entity_type. Both current entity types are guaranteed to have no open
 * workflow once in a listed status: a 'closed'/'written_off' loan has no
 * more repayments expected (loanService enforces zero balance before
 * closing), and a 'closed' savings account cannot even be reached while
 * an active overdraft is attached to it — the module prompt's "never
 * archive a record still referenced by an open workflow" rule is
 * satisfied structurally by only ever targeting these terminal statuses,
 * not by a separate runtime check here.
 */
const ARCHIVE_ENTITY_CONFIG = {
  closed_loans: { table: 'loans', statuses: ['closed', 'written_off'] },
  closed_savings_accounts: { table: 'savings_accounts', statuses: ['closed'] },
};

async function createArchivePolicy(pool, { entityType, retentionPeriodDays, archiveLocation, createdBy }) {
  if (!ARCHIVE_ENTITY_CONFIG[entityType]) {
    throw new SystemAdminValidationError(`entityType must be one of ${Object.keys(ARCHIVE_ENTITY_CONFIG).join(', ')}`);
  }
  if (!retentionPeriodDays || !archiveLocation || !createdBy) {
    throw new SystemAdminValidationError('retentionPeriodDays, archiveLocation, and createdBy are required');
  }
  const { rows } = await pool.query(
    `INSERT INTO archive_policies (entity_type, retention_period_days, archive_location, created_by)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [entityType, retentionPeriodDays, archiveLocation, createdBy]
  );
  return rows[0];
}

async function listArchivePolicies(pool, { status } = {}) {
  const params = [];
  let where = '';
  if (status) {
    params.push(status);
    where = 'WHERE status = $1';
  }
  const { rows } = await pool.query(`SELECT * FROM archive_policies ${where} ORDER BY id`, params);
  return rows;
}

/**
 * Marks eligible records with `archived_at` and logs them to
 * `archived_records` — the row is NEVER physically moved or deleted, so
 * every existing query/report (Module 7's historical reports included)
 * keeps resolving it exactly as before. See migration 050's own comment.
 */
async function runArchivePolicy(pool, { policyId, triggeredBy }) {
  if (!triggeredBy) throw new SystemAdminValidationError('triggeredBy is required');
  const { rows: policyRows } = await pool.query('SELECT * FROM archive_policies WHERE id = $1', [policyId]);
  const policy = policyRows[0];
  if (!policy) throw new SystemAdminNotFoundError(`archive_policy ${policyId} not found`);
  if (policy.status !== 'active') throw new SystemAdminConflictError(`archive_policy ${policyId} is not active`);

  const config = ARCHIVE_ENTITY_CONFIG[policy.entity_type];
  const { rows: eligible } = await pool.query(
    `SELECT id FROM ${config.table}
      WHERE status = ANY($1) AND updated_at < now() - ($2 || ' days')::interval AND archived_at IS NULL`,
    [config.statuses, policy.retention_period_days]
  );

  for (const row of eligible) {
    await pool.query(`UPDATE ${config.table} SET archived_at = now() WHERE id = $1`, [row.id]);
    await pool.query(
      `INSERT INTO archived_records (entity_type, entity_id, policy_id, archive_location)
       VALUES ($1, $2, $3, $4) ON CONFLICT (entity_type, entity_id) DO NOTHING`,
      [policy.entity_type, row.id, policy.id, policy.archive_location]
    );
  }

  return { entityType: policy.entity_type, archivedCount: eligible.length, ids: eligible.map((r) => Number(r.id)) };
}

async function listArchivedRecords(pool, { entityType } = {}) {
  const params = [];
  let where = '';
  if (entityType) {
    params.push(entityType);
    where = 'WHERE entity_type = $1';
  }
  const { rows } = await pool.query(`SELECT * FROM archived_records ${where} ORDER BY archived_at DESC`, params);
  return rows;
}

// --- Backup / restore / CSV export -----------------------------------------------

const BACKUP_DIR = path.join(__dirname, '../../../var/backups');

function ensureBackupDir() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

/**
 * Real pg_dump-based backup. Uses `execFile` (never a shell string), and
 * every argument is either a server-side env var (DATABASE_URL) or a
 * filename generated here — never anything from a request body — so
 * there is no command-injection surface.
 */
async function triggerBackup(pool, { triggeredBy }) {
  if (!triggeredBy) throw new SystemAdminValidationError('triggeredBy is required');
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new SystemAdminValidationError('DATABASE_URL is not configured');
  ensureBackupDir();

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(BACKUP_DIR, `swiftcedi-backup-${timestamp}.sql`);

  const { rows } = await pool.query('INSERT INTO backup_runs (triggered_by) VALUES ($1) RETURNING *', [triggeredBy]);
  const run = rows[0];

  try {
    await execFileAsync('pg_dump', [connectionString, '--no-owner', '--no-privileges', '-f', filePath]);
    const { size } = fs.statSync(filePath);
    const { rows: updated } = await pool.query(
      `UPDATE backup_runs SET status = 'success', completed_at = now(), file_path = $1, file_size_bytes = $2 WHERE id = $3 RETURNING *`,
      [filePath, size, run.id]
    );
    return updated[0];
  } catch (err) {
    const { rows: updated } = await pool.query(
      `UPDATE backup_runs SET status = 'failed', completed_at = now(), error_message = $1 WHERE id = $2 RETURNING *`,
      [err.message, run.id]
    );
    return updated[0];
  }
}

async function listBackupRuns(pool, { status } = {}) {
  const params = [];
  let where = '';
  if (status) {
    params.push(status);
    where = 'WHERE status = $1';
  }
  const { rows } = await pool.query(`SELECT * FROM backup_runs ${where} ORDER BY started_at DESC`, params);
  return rows;
}

/**
 * HIGH RISK: overwrites live data, irreversibly. Gated three ways beyond
 * the route's own permission check: (1) `confirm: true` must be passed
 * explicitly, (2) `filePath` is resolved against BACKUP_DIR and rejected
 * if it would escape that directory (no path traversal to an arbitrary
 * filesystem path), (3) every restore attempt is audit-logged before the
 * destructive command runs, not after. Not exercised against a real
 * database in this session's own tests for the same reason it's risky in
 * production — see Decisions_Log.md.
 */
async function triggerRestore(pool, { filePath, triggeredBy, actorBranchId, confirm }) {
  if (!triggeredBy || !actorBranchId) throw new SystemAdminValidationError('triggeredBy and actorBranchId are required');
  if (confirm !== true) {
    throw new SystemAdminValidationError('restore is a destructive operation; confirm must be explicitly set to true');
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new SystemAdminValidationError('DATABASE_URL is not configured');
  if (!filePath) throw new SystemAdminValidationError('filePath is required');

  const resolvedDir = path.resolve(BACKUP_DIR) + path.sep;
  const resolvedPath = path.resolve(BACKUP_DIR, filePath);
  if (!resolvedPath.startsWith(resolvedDir)) {
    throw new SystemAdminValidationError('filePath must reference a file inside the backup directory');
  }
  if (!fs.existsSync(resolvedPath)) throw new SystemAdminNotFoundError(`backup file not found: ${filePath}`);

  await auditLog.record(pool, {
    userId: triggeredBy,
    branchId: actorBranchId,
    action: 'sysadmin.restore_triggered',
    entityType: 'backup_run',
    entityId: filePath,
    afterState: { filePath: resolvedPath },
  });

  await execFileAsync('psql', [connectionString, '-f', resolvedPath]);
  return { restored: true, filePath: resolvedPath };
}

const EXPORTABLE_TABLES = ['branches', 'customers', 'loans', 'savings_accounts', 'investments', 'gl_accounts'];

function toCsvValue(value) {
  if (value === null || value === undefined) return '';
  const str = value instanceof Date ? value.toISOString() : String(value);
  return /["\,\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

/**
 * "Backup-to-Excel export for non-technical staff" — implemented honestly
 * as CSV (opens directly in Excel) rather than adding a new xlsx/exceljs
 * dependency this codebase doesn't otherwise need. Restricted to a fixed
 * allowlist of "key tables", never an arbitrary caller-supplied table
 * name interpolated into SQL.
 */
async function exportTableToCsv(pool, { tableName }) {
  if (!EXPORTABLE_TABLES.includes(tableName)) {
    throw new SystemAdminValidationError(`tableName must be one of ${EXPORTABLE_TABLES.join(', ')}`);
  }
  const { rows, fields } = await pool.query(`SELECT * FROM ${tableName} ORDER BY id`);
  const header = fields.map((f) => f.name).join(',');
  const lines = rows.map((row) => fields.map((f) => toCsvValue(row[f.name])).join(','));
  return [header, ...lines].join('\n');
}

// --- Subscription / licence tracking ----------------------------------------------

/**
 * SaaS-readiness tracking ONLY — "if/when SaaS multi-tenancy is
 * introduced" (module prompt's own conditional framing). This codebase
 * is single-tenant today; nothing reads this table to enforce tenant
 * isolation or gate any feature. See Decisions_Log.md.
 */
async function createSubscriptionLicence(pool, { tenantName, plan, seats, startDate, endDate, createdBy }) {
  if (!tenantName || !plan || !seats || !startDate || !endDate || !createdBy) {
    throw new SystemAdminValidationError('tenantName, plan, seats, startDate, endDate, and createdBy are required');
  }
  const { rows } = await pool.query(
    `INSERT INTO subscription_licences (tenant_name, plan, seats, start_date, end_date, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [tenantName, plan, seats, startDate, endDate, createdBy]
  );
  return rows[0];
}

async function listSubscriptionLicences(pool, { status } = {}) {
  const params = [];
  let where = '';
  if (status) {
    params.push(status);
    where = 'WHERE status = $1';
  }
  const { rows } = await pool.query(`SELECT * FROM subscription_licences ${where} ORDER BY end_date`, params);
  return rows;
}

// --- Reminder notifications (log-only; no real delivery gateway) --------------------

async function listReminderNotifications(pool, { status, notificationType, customerId } = {}) {
  const clauses = [];
  const params = [];
  const add = (col, val) => {
    if (val === undefined || val === null) return;
    params.push(val);
    clauses.push(`${col} = $${params.length}`);
  };
  add('status', status);
  add('notification_type', notificationType);
  add('customer_id', customerId);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await pool.query(`SELECT * FROM reminder_notifications ${where} ORDER BY due_date`, params);
  return rows;
}

/** The integration point a real SMS/push/email provider would call after actually dispatching a reminder — nothing in this codebase calls these two automatically yet. */
async function markNotificationSent(pool, { notificationId }) {
  const { rows } = await pool.query(
    `UPDATE reminder_notifications SET status = 'sent', sent_at = now() WHERE id = $1 RETURNING *`,
    [notificationId]
  );
  if (!rows[0]) throw new SystemAdminNotFoundError(`reminder_notification ${notificationId} not found`);
  return rows[0];
}

async function markNotificationFailed(pool, { notificationId }) {
  const { rows } = await pool.query(
    `UPDATE reminder_notifications SET status = 'failed' WHERE id = $1 RETURNING *`,
    [notificationId]
  );
  if (!rows[0]) throw new SystemAdminNotFoundError(`reminder_notification ${notificationId} not found`);
  return rows[0];
}

module.exports = {
  JOB_REGISTRY,
  createScheduledJob,
  listScheduledJobs,
  updateScheduledJobStatus,
  triggerJob,
  listJobRunHistory,
  createArchivePolicy,
  listArchivePolicies,
  runArchivePolicy,
  listArchivedRecords,
  triggerBackup,
  listBackupRuns,
  triggerRestore,
  exportTableToCsv,
  EXPORTABLE_TABLES,
  createSubscriptionLicence,
  listSubscriptionLicences,
  listReminderNotifications,
  markNotificationSent,
  markNotificationFailed,
  SystemAdminValidationError,
  SystemAdminNotFoundError,
  SystemAdminConflictError,
};
