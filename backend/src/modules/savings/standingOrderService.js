'use strict';

const auditLog = require('../../shared/auditLog');
const glPosting = require('../../shared/glPosting');
const savingsMath = require('./savingsMath');
const savingsService = require('./savingsService');
const calendarMath = require('../systemAdmin/calendarMath');
const calendarService = require('../systemAdmin/calendarService');

/**
 * Module 4: standing orders — recurring transfers between savings
 * accounts, executed by Module 12's scheduler calling `executeDueOrders`.
 *
 * Every run writes a `standing_order_runs` row whether it succeeds or
 * fails, so a failure (insufficient funds) is never silent — the business
 * rule. A failure reschedules by the order's own `retry_after_days` and
 * suspends the order once `max_consecutive_failures` is hit, rather than
 * retrying forever.
 */

class StandingOrderValidationError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 400;
  }
}
class StandingOrderNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 404;
  }
}

const todayIso = () => new Date().toISOString().slice(0, 10);

async function createStandingOrder(pool, params) {
  const {
    sourceAccountId,
    destinationAccountId,
    amountPesewas,
    frequency,
    startDate = todayIso(),
    endDate = null,
    retryAfterDays = 3,
    maxConsecutiveFailures = 3,
    createdBy,
  } = params;

  if (!sourceAccountId || !destinationAccountId || !frequency || !createdBy) {
    throw new StandingOrderValidationError(
      'sourceAccountId, destinationAccountId, frequency, and createdBy are required'
    );
  }
  if (!Number.isInteger(amountPesewas) || amountPesewas <= 0) {
    throw new StandingOrderValidationError('amountPesewas must be a positive integer');
  }
  if (Number(sourceAccountId) === Number(destinationAccountId)) {
    throw new StandingOrderValidationError('sourceAccountId and destinationAccountId must differ');
  }
  // Validate the frequency here rather than letting the CHECK constraint
  // surface a raw Postgres error.
  savingsMath.nextRunDate(startDate, frequency);

  const source = await savingsService.getAccount(pool, sourceAccountId);
  const destination = await savingsService.getAccount(pool, destinationAccountId);
  if (source.status !== 'active') throw new StandingOrderValidationError(`source account ${sourceAccountId} is not active`);
  if (destination.status !== 'active') {
    throw new StandingOrderValidationError(`destination account ${destinationAccountId} is not active`);
  }
  if (Number(source.branch_id) !== Number(destination.branch_id)) {
    // Cross-branch transfers would need a due-to/due-from GL pair; out of
    // scope here and flagged in Decisions_Log.md rather than posting an
    // unbalanced-across-branches entry.
    throw new StandingOrderValidationError('cross-branch standing orders are not supported yet');
  }

  const { rows } = await pool.query(
    `INSERT INTO standing_orders
       (source_account_id, destination_account_id, amount_pesewas, frequency, next_run_date, end_date,
        retry_after_days, max_consecutive_failures, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [
      sourceAccountId,
      destinationAccountId,
      amountPesewas,
      frequency,
      startDate,
      endDate,
      retryAfterDays,
      maxConsecutiveFailures,
      createdBy,
    ]
  );

  await auditLog.record(pool, {
    userId: createdBy,
    branchId: source.branch_id,
    action: 'standing_order.created',
    entityType: 'standing_order',
    entityId: rows[0].id,
    afterState: rows[0],
  });

  return rows[0];
}

async function getStandingOrder(pool, standingOrderId) {
  const { rows } = await pool.query('SELECT * FROM standing_orders WHERE id = $1', [standingOrderId]);
  if (!rows[0]) throw new StandingOrderNotFoundError(`standing_order ${standingOrderId} not found`);
  return rows[0];
}

async function listStandingOrders(pool, { sourceAccountId, status } = {}) {
  const clauses = [];
  const params = [];
  const add = (col, val) => {
    if (val === undefined || val === null) return;
    params.push(val);
    clauses.push(`${col} = $${params.length}`);
  };
  add('source_account_id', sourceAccountId);
  add('status', status);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await pool.query(`SELECT * FROM standing_orders ${where} ORDER BY next_run_date, id`, params);
  return rows;
}

async function setStandingOrderStatus(pool, { standingOrderId, status, actorId }) {
  if (!['active', 'paused', 'cancelled'].includes(status)) {
    throw new StandingOrderValidationError("status must be 'active', 'paused', or 'cancelled'");
  }
  const order = await getStandingOrder(pool, standingOrderId);
  const { rows } = await pool.query(
    'UPDATE standing_orders SET status = $1, updated_at = now() WHERE id = $2 RETURNING *',
    [status, standingOrderId]
  );
  const source = await savingsService.getAccount(pool, order.source_account_id);
  await auditLog.record(pool, {
    userId: actorId,
    branchId: source.branch_id,
    action: 'standing_order.status_changed',
    entityType: 'standing_order',
    entityId: standingOrderId,
    beforeState: { status: order.status },
    afterState: { status },
  });
  return rows[0];
}

async function listRuns(pool, { standingOrderId, status } = {}) {
  const clauses = [];
  const params = [];
  if (standingOrderId) {
    params.push(standingOrderId);
    clauses.push(`standing_order_id = $${params.length}`);
  }
  if (status) {
    params.push(status);
    clauses.push(`status = $${params.length}`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await pool.query(`SELECT * FROM standing_order_runs ${where} ORDER BY id DESC`, params);
  return rows;
}

/** Failed runs nobody has told the customer about yet — see Decisions_Log.md Open Questions. */
async function listUnnotifiedFailures(pool) {
  const { rows } = await pool.query(
    `SELECT r.*, o.source_account_id, o.destination_account_id, o.amount_pesewas
       FROM standing_order_runs r JOIN standing_orders o ON o.id = r.standing_order_id
      WHERE r.status = 'failed' AND r.customer_notified = false
      ORDER BY r.id`
  );
  return rows;
}

/**
 * Executes one standing order. Returns a result object rather than
 * throwing on insufficient funds — a failed transfer is an expected
 * business outcome that must be recorded, not an exception.
 */
async function executeOrder(pool, { standingOrderId, runDate = todayIso(), executedBy }) {
  if (!executedBy) throw new StandingOrderValidationError('executedBy is required');
  const order = await getStandingOrder(pool, standingOrderId);

  if (order.status !== 'active') {
    return { standingOrderId: Number(standingOrderId), skipped: true, reason: `order is ${order.status}` };
  }

  const source = await savingsService.getAccount(pool, order.source_account_id);
  const destination = await savingsService.getAccount(pool, order.destination_account_id);
  const amountPesewas = Number(order.amount_pesewas);

  const { chargesConfig } = await savingsService.getChargesConfigForAccount(pool, source);
  const availability = savingsMath.assessWithdrawal({
    balancePesewas: source.balance_pesewas,
    amountPesewas,
    // A standing order transfer is not a counter withdrawal — the
    // withdrawal fee does not apply, but the minimum balance still does.
    chargesConfig: { ...chargesConfig, withdrawalFeePesewas: 0 },
  });

  if (!availability.ok || source.status !== 'active' || destination.status !== 'active') {
    const reason = !availability.ok
      ? availability.error
      : `account not active (source: ${source.status}, destination: ${destination.status})`;
    return recordFailure(pool, { order, runDate, reason, executedBy });
  }

  const glAccountsBranchId = source.branch_id;
  const debit = await savingsService.applyMovement(pool, {
    accountId: order.source_account_id,
    txnType: 'standing_order_out',
    deltaPesewas: -amountPesewas,
    description: `Standing order ${order.id} to ${destination.account_no}`,
    createdBy: executedBy,
    entryDate: runDate,
    reference: `SO-${order.id}-OUT-${runDate}`,
    // Both legs are customer-deposit liability movements within one
    // branch, so the GL entry nets to zero on the control account; the
    // subledger movement is what actually differs.
    buildGlLines: ({ glAccounts, branchId }) => [
      { accountId: glAccounts.customer_deposits_account_id, debitPesewas: amountPesewas, branchId },
      { accountId: glAccounts.cash_in_hand_account_id, creditPesewas: amountPesewas, branchId },
    ],
  });

  const credit = await savingsService.applyMovement(pool, {
    accountId: order.destination_account_id,
    txnType: 'standing_order_in',
    deltaPesewas: amountPesewas,
    description: `Standing order ${order.id} from ${source.account_no}`,
    createdBy: executedBy,
    entryDate: runDate,
    reference: `SO-${order.id}-IN-${runDate}`,
    buildGlLines: ({ glAccounts, branchId }) => [
      { accountId: glAccounts.cash_in_hand_account_id, debitPesewas: amountPesewas, branchId },
      { accountId: glAccounts.customer_deposits_account_id, creditPesewas: amountPesewas, branchId },
    ],
  });

  // Module 12: roll the computed next run date forward past non-working
  // days — see calendarMath.js. Only ever applied here, at the moment a
  // FUTURE run date is computed, never retroactively to a past run.
  const rawNextRun = savingsMath.nextRunDate(runDate, order.frequency);
  const calendarOverrides = await calendarService.getWorkingCalendarOverrides(pool, {
    fromDate: rawNextRun,
    toDate: savingsMath.addDaysToDateString(rawNextRun, 14),
  });
  const nextRun = calendarMath.rollForwardToWorkingDay(rawNextRun, calendarOverrides);
  const completed = order.end_date && nextRun > order.end_date.toISOString().slice(0, 10);

  const { rows: runRows } = await pool.query(
    `INSERT INTO standing_order_runs (standing_order_id, run_date, status, transaction_id)
     VALUES ($1, $2, 'success', $3) RETURNING *`,
    [order.id, runDate, debit.transaction.id]
  );

  await pool.query(
    `UPDATE standing_orders
        SET next_run_date = $1, status = $2, consecutive_failures = 0, last_error = NULL, updated_at = now()
      WHERE id = $3`,
    [nextRun, completed ? 'completed' : 'active', order.id]
  );

  await auditLog.record(pool, {
    userId: executedBy,
    branchId: glAccountsBranchId,
    action: 'standing_order.executed',
    entityType: 'standing_order',
    entityId: order.id,
    afterState: { runDate, amountPesewas, nextRunDate: nextRun, completed },
  });

  return {
    standingOrderId: Number(order.id),
    success: true,
    amountPesewas,
    nextRunDate: nextRun,
    completed: Boolean(completed),
    run: runRows[0],
    sourceBalanceAfterPesewas: debit.balanceAfterPesewas,
    destinationBalanceAfterPesewas: credit.balanceAfterPesewas,
  };
}

async function recordFailure(pool, { order, runDate, reason, executedBy }) {
  const consecutiveFailures = order.consecutive_failures + 1;
  const suspended = consecutiveFailures >= order.max_consecutive_failures;
  const retryDate = savingsMath.addDaysToDateString(runDate, order.retry_after_days);

  const { rows: runRows } = await pool.query(
    `INSERT INTO standing_order_runs (standing_order_id, run_date, status, failure_reason)
     VALUES ($1, $2, 'failed', $3) RETURNING *`,
    [order.id, runDate, reason]
  );

  await pool.query(
    `UPDATE standing_orders
        SET consecutive_failures = $1, last_error = $2, next_run_date = $3, status = $4, updated_at = now()
      WHERE id = $5`,
    [consecutiveFailures, reason, retryDate, suspended ? 'suspended' : 'active', order.id]
  );

  const source = await savingsService.getAccount(pool, order.source_account_id);
  await auditLog.record(pool, {
    userId: executedBy,
    branchId: source.branch_id,
    action: 'standing_order.failed',
    entityType: 'standing_order',
    entityId: order.id,
    afterState: { runDate, reason, consecutiveFailures, retryDate, suspended },
  });

  return {
    standingOrderId: Number(order.id),
    success: false,
    reason,
    consecutiveFailures,
    suspended,
    nextRunDate: retryDate,
    run: runRows[0],
  };
}

/** Scheduler entry point (Module 12 will call this). */
async function executeDueOrders(pool, { asOfDate = todayIso(), executedBy, limit = 100 }) {
  if (!executedBy) throw new StandingOrderValidationError('executedBy is required');
  const { rows } = await pool.query(
    `SELECT id FROM standing_orders
      WHERE status = 'active' AND next_run_date <= $1
      ORDER BY next_run_date, id LIMIT $2`,
    [asOfDate, Math.min(Number(limit) || 100, 1000)]
  );

  const results = [];
  for (const row of rows) {
    results.push(await executeOrder(pool, { standingOrderId: row.id, runDate: asOfDate, executedBy }));
  }
  return {
    asOfDate,
    executed: results.length,
    succeeded: results.filter((r) => r.success).length,
    failed: results.filter((r) => r.success === false).length,
    results,
  };
}

module.exports = {
  createStandingOrder,
  getStandingOrder,
  listStandingOrders,
  setStandingOrderStatus,
  executeOrder,
  executeDueOrders,
  listRuns,
  listUnnotifiedFailures,
  StandingOrderValidationError,
  StandingOrderNotFoundError,
};
