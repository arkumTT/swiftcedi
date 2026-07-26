'use strict';

const auditLog = require('./auditLog');
const approvalWorkflow = require('./approvalWorkflow');

/**
 * Shared GL posting interface (Module 7). No module writes to
 * `gl_journal_lines` directly — every module posts through
 * `postJournalEntry()`. The database also enforces the balanced-entry rule
 * and immutability at the trigger level (migration 007_gl_journal.sql) as
 * defense in depth, but the application-layer check here is what runs first
 * and gives callers a clear, typed error.
 */

// statusCode is set here (400/409) so newer routes can rely on the
// generic err.statusCode fallback in app.js's error handler, per
// Decisions_Log.md's API Conventions — older routes (routes/gl.js) still
// use explicit `instanceof` checks and both patterns coexist fine, since
// adding a property doesn't change instanceof behavior.
class GlPostingValidationError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 400;
  }
}
class UnbalancedEntryError extends GlPostingValidationError {}
class PeriodLockedError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 409;
  }
}
class GlPostingConflictError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 409;
  }
}

/**
 * Pure validation: every line has exactly one of debit/credit set, amounts
 * are non-negative integers (pesewas), and total debit === total credit.
 * Exported so it's directly unit-testable without a database.
 */
function validateBalancedLines(lines) {
  if (!Array.isArray(lines) || lines.length < 2) {
    throw new UnbalancedEntryError('a journal entry requires at least two lines');
  }

  let totalDebit = 0;
  let totalCredit = 0;

  lines.forEach((line, index) => {
    const debit = Number(line.debitPesewas || 0);
    const credit = Number(line.creditPesewas || 0);

    if (!Number.isInteger(debit) || !Number.isInteger(credit)) {
      throw new UnbalancedEntryError(`line ${index}: debitPesewas/creditPesewas must be integers (pesewas), never floats`);
    }
    if (debit < 0 || credit < 0) {
      throw new UnbalancedEntryError(`line ${index}: amounts cannot be negative`);
    }
    if ((debit > 0 ? 1 : 0) + (credit > 0 ? 1 : 0) !== 1) {
      throw new UnbalancedEntryError(`line ${index}: exactly one of debitPesewas/creditPesewas must be greater than zero`);
    }
    if (!line.accountId) {
      throw new UnbalancedEntryError(`line ${index}: accountId is required`);
    }

    totalDebit += debit;
    totalCredit += credit;
  });

  if (totalDebit !== totalCredit) {
    throw new UnbalancedEntryError(
      `journal entry is unbalanced: total debit ${totalDebit} pesewas !== total credit ${totalCredit} pesewas`
    );
  }

  return { totalDebit, totalCredit };
}

/**
 * Normalize a debit/credit total pair into a signed balance using the
 * account type's natural side, so callers get "the balance" rather than
 * having to know accounting sign conventions per account type.
 */
function normalizeBalance(accountType, debitTotal, creditTotal) {
  const debit = Number(debitTotal);
  const credit = Number(creditTotal);
  if (accountType === 'asset' || accountType === 'expense') {
    return debit - credit;
  }
  return credit - debit;
}

async function assertPeriodOpen(client, { branchId, entryDate, entryType }) {
  if (entryType === 'prior_period_adjustment') return;

  const { rows } = await client.query(
    `SELECT id FROM gl_periods
     WHERE (branch_id = $1 OR branch_id IS NULL)
       AND period_start <= $2 AND period_end >= $2
       AND locked = true
     LIMIT 1`,
    [branchId, entryDate]
  );

  if (rows.length > 0) {
    throw new PeriodLockedError(
      `the GL period covering ${entryDate} is locked for branch ${branchId}; ` +
        "use entryType 'prior_period_adjustment' to post a corrective entry"
    );
  }
}

/**
 * Post a balanced double-entry journal entry.
 *
 * @param {import('pg').Pool} pool - must support `.connect()`; this
 *   function owns its own transaction (BEGIN/COMMIT/ROLLBACK) since it is
 *   the single funnel every module posts through.
 * @param {object} params
 * @param {number} params.branchId
 * @param {string} params.reference
 * @param {string} [params.description]
 * @param {string} params.entryDate - 'YYYY-MM-DD'
 * @param {string} params.sourceModule - e.g. 'loan', 'savings', 'cashier', 'manual_jv'
 * @param {number} params.createdBy
 * @param {number} [params.approvedBy]
 * @param {'standard'|'prior_period_adjustment'} [params.entryType='standard']
 * @param {Array<{accountId: number, debitPesewas?: number, creditPesewas?: number, branchId?: number}>} params.lines
 */
async function postJournalEntry(pool, params) {
  const {
    branchId,
    reference,
    description = null,
    entryDate,
    sourceModule,
    createdBy,
    approvedBy = null,
    entryType = 'standard',
    lines,
  } = params;

  const missing = ['branchId', 'reference', 'entryDate', 'sourceModule', 'createdBy'].filter((f) => !params[f]);
  if (missing.length > 0) {
    throw new GlPostingValidationError(`postJournalEntry missing required field(s): ${missing.join(', ')}`);
  }

  validateBalancedLines(lines);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await assertPeriodOpen(client, { branchId, entryDate, entryType });

    const { rows: entryRows } = await client.query(
      `INSERT INTO gl_journal_entries
         (branch_id, reference, entry_type, description, entry_date, source_module, created_by, approved_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [branchId, reference, entryType, description, entryDate, sourceModule, createdBy, approvedBy]
    );
    const entry = entryRows[0];

    const insertedLines = [];
    for (const line of lines) {
      const { rows: lineRows } = await client.query(
        `INSERT INTO gl_journal_lines (journal_entry_id, account_id, debit_pesewas, credit_pesewas, branch_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [entry.id, line.accountId, line.debitPesewas || 0, line.creditPesewas || 0, line.branchId || branchId]
      );
      insertedLines.push(lineRows[0]);
    }

    await auditLog.record(client, {
      userId: createdBy,
      branchId,
      action: `gl.post_journal.${sourceModule}`,
      entityType: 'gl_journal_entry',
      entityId: entry.id,
      afterState: { ...entry, lines: insertedLines },
    });

    await client.query('COMMIT');
    return { ...entry, lines: insertedLines };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Reverses a posted journal entry: builds a NEW entry with every line's
 * debit/credit swapped (same accounts, same amounts — a true offsetting
 * entry), links it back via `reverses_entry_id`, and flips the ORIGINAL
 * entry's status to 'reversed'. The original's lines are never touched —
 * they're immutable at the DB layer regardless. Reuses `postJournalEntry`
 * for the actual insert (period-lock check, balance validation, audit
 * log) rather than duplicating any of that.
 *
 * Added in Module 6 to activate `gl_journal_entries.status = 'reversed'`,
 * which has existed in the CHECK constraint (and Decisions_Log) since
 * Module 7 but had no producer until now — see Decisions_Log.md.
 *
 * @param {import('pg').Pool} pool
 * @param {object} params
 * @param {number} params.originalEntryId
 * @param {string} params.reason
 * @param {number} params.reversedBy
 * @param {string} params.entryDate - 'YYYY-MM-DD'
 * @param {'standard'|'prior_period_adjustment'} [params.entryType='standard']
 */
async function reverseJournalEntry(pool, { originalEntryId, reason, reversedBy, entryDate, entryType = 'standard' }) {
  if (!originalEntryId || !reason || !reversedBy || !entryDate) {
    throw new GlPostingValidationError(
      `reverseJournalEntry missing required field(s): ${['originalEntryId', 'reason', 'reversedBy', 'entryDate']
        .filter((f) => !{ originalEntryId, reason, reversedBy, entryDate }[f])
        .join(', ')}`
    );
  }

  const { rows: entryRows } = await pool.query('SELECT * FROM gl_journal_entries WHERE id = $1', [originalEntryId]);
  const original = entryRows[0];
  if (!original) {
    throw new GlPostingValidationError(`gl_journal_entries ${originalEntryId} not found`);
  }
  if (original.status !== 'posted') {
    throw new GlPostingValidationError(
      `gl_journal_entries ${originalEntryId} is not posted (status: ${original.status}); it may already be reversed`
    );
  }

  const { rows: lineRows } = await pool.query('SELECT * FROM gl_journal_lines WHERE journal_entry_id = $1', [
    originalEntryId,
  ]);
  const swappedLines = lineRows.map((line) => ({
    accountId: line.account_id,
    debitPesewas: Number(line.credit_pesewas),
    creditPesewas: Number(line.debit_pesewas),
    branchId: line.branch_id,
  }));

  const reversalEntry = await postJournalEntry(pool, {
    branchId: original.branch_id,
    reference: `REV-${original.reference}`,
    description: `Reversal of entry ${originalEntryId}: ${reason}`,
    entryDate,
    sourceModule: original.source_module,
    createdBy: reversedBy,
    entryType,
    lines: swappedLines,
  });

  const client = await pool.connect();
  let updatedOriginal;
  try {
    await client.query('BEGIN');
    await client.query('UPDATE gl_journal_entries SET reverses_entry_id = $1 WHERE id = $2', [
      originalEntryId,
      reversalEntry.id,
    ]);
    const { rows: updatedRows } = await client.query(
      "UPDATE gl_journal_entries SET status = 'reversed' WHERE id = $1 RETURNING *",
      [originalEntryId]
    );
    updatedOriginal = updatedRows[0];
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await auditLog.record(pool, {
    userId: reversedBy,
    branchId: original.branch_id,
    action: 'gl.reversed',
    entityType: 'gl_journal_entry',
    entityId: originalEntryId,
    beforeState: { status: 'posted' },
    afterState: { status: 'reversed', reversalEntryId: reversalEntry.id, reason },
  });

  return { reversalEntry: { ...reversalEntry, reverses_entry_id: originalEntryId }, originalEntry: updatedOriginal };
}

// --- Prior-period adjustments (back-dated corrections into a locked period) -

/**
 * Requests a back-dated correction into a LOCKED gl_periods row — the
 * module spec's "distinct back-dated adjustment workflow with extra
 * approval" (added while building Module 6, but deliberately not
 * Module-6-specific — any module could need this). ALWAYS requires
 * maker-checker, no threshold escape hatch. Snapshots the proposed
 * `lines` at request time so what eventually posts can never silently
 * drift from what a checker reviewed.
 */
async function requestPriorPeriodAdjustment(pool, { branchId, entryDate, description, lines, requestedBy }) {
  if (!branchId || !entryDate || !description || !requestedBy) {
    throw new GlPostingValidationError('branchId, entryDate, description, and requestedBy are required');
  }
  const { totalDebit } = validateBalancedLines(lines);

  const { rows } = await pool.query(
    `INSERT INTO gl_prior_period_adjustments (branch_id, entry_date, description, lines, requested_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [branchId, entryDate, description, JSON.stringify(lines), requestedBy]
  );
  const adjustment = rows[0];

  const approvalRequest = await approvalWorkflow.requestApproval(pool, {
    actionType: 'gl.prior_period_adjustment',
    entityType: 'gl_prior_period_adjustment',
    entityId: adjustment.id,
    branchId,
    requestedBy,
    amountPesewas: totalDebit,
  });

  const { rows: updatedRows } = await pool.query(
    'UPDATE gl_prior_period_adjustments SET approval_request_id = $1, updated_at = now() WHERE id = $2 RETURNING *',
    [approvalRequest.id, adjustment.id]
  );

  return { adjustment: updatedRows[0], approvalRequest };
}

/**
 * Registered as the 'gl.prior_period_adjustment' execution handler —
 * only flips the adjustment to `approved` here. The actual posting
 * (`postJournalEntry` owns its own transaction) happens afterward via
 * `postApprovedPriorPeriodAdjustment`, same two-phase shape every other
 * approval-gated GL posting in this codebase uses.
 */
async function applyPriorPeriodAdjustmentApprovalDecision(approvalRequest, db) {
  const { rows: adjustmentRows } = await db.query(
    'SELECT * FROM gl_prior_period_adjustments WHERE approval_request_id = $1 FOR UPDATE',
    [approvalRequest.id]
  );
  const adjustment = adjustmentRows[0];
  if (!adjustment) {
    throw new GlPostingValidationError(`no gl_prior_period_adjustments row for approval_request ${approvalRequest.id}`);
  }

  const { rows } = await db.query(
    "UPDATE gl_prior_period_adjustments SET status = 'approved', updated_at = now() WHERE id = $1 RETURNING *",
    [adjustment.id]
  );

  await auditLog.record(db, {
    userId: approvalRequest.decided_by,
    branchId: approvalRequest.branch_id,
    action: 'gl.prior_period_adjustment_approved',
    entityType: 'gl_prior_period_adjustment',
    entityId: adjustment.id,
    beforeState: { status: adjustment.status },
    afterState: { status: rows[0].status },
  });
}

/** Posts an approved prior-period adjustment, using entryType = 'prior_period_adjustment' — the only value assertPeriodOpen() lets through a locked period. */
async function postApprovedPriorPeriodAdjustment(pool, { adjustmentId, postedBy }) {
  const { rows } = await pool.query('SELECT * FROM gl_prior_period_adjustments WHERE id = $1', [adjustmentId]);
  const adjustment = rows[0];
  if (!adjustment) throw new GlPostingValidationError(`gl_prior_period_adjustments ${adjustmentId} not found`);
  if (adjustment.status !== 'approved') {
    throw new GlPostingConflictError(
      `gl_prior_period_adjustments ${adjustmentId} is not approved (status: ${adjustment.status})`
    );
  }

  const journalEntry = await postJournalEntry(pool, {
    branchId: adjustment.branch_id,
    reference: `PPA-${adjustmentId}`,
    description: adjustment.description,
    entryDate: adjustment.entry_date,
    sourceModule: 'gl_prior_period_adjustment',
    createdBy: postedBy,
    entryType: 'prior_period_adjustment',
    lines: adjustment.lines,
  });

  const { rows: updatedRows } = await pool.query(
    "UPDATE gl_prior_period_adjustments SET status = 'posted', journal_entry_id = $1, updated_at = now() WHERE id = $2 RETURNING *",
    [journalEntry.id, adjustmentId]
  );

  return { adjustment: updatedRows[0], journalEntry };
}

/** Call once at app startup so decide() can dispatch prior-period-adjustment approvals. */
function registerGlExecutionHandlers() {
  approvalWorkflow.registerExecutionHandler('gl.prior_period_adjustment', applyPriorPeriodAdjustmentApprovalDecision);
}

/**
 * Reconstruct an account's balance as of a given date from
 * `gl_journal_lines` directly (never from a mutable running-balance
 * column), so restated/corrected history stays accurate.
 */
async function getAccountBalance(db, { accountId, asOfDate = null, branchId = null }) {
  const { rows: accountRows } = await db.query('SELECT account_type FROM gl_accounts WHERE id = $1', [accountId]);
  const account = accountRows[0];
  if (!account) {
    throw new GlPostingValidationError(`gl_accounts ${accountId} not found`);
  }

  const params = [accountId];
  let where = 'l.account_id = $1';
  if (asOfDate) {
    params.push(asOfDate);
    where += ` AND e.entry_date <= $${params.length}`;
  }
  if (branchId) {
    params.push(branchId);
    where += ` AND l.branch_id = $${params.length}`;
  }

  const { rows } = await db.query(
    `SELECT COALESCE(SUM(l.debit_pesewas), 0) AS total_debit, COALESCE(SUM(l.credit_pesewas), 0) AS total_credit
     FROM gl_journal_lines l
     JOIN gl_journal_entries e ON e.id = l.journal_entry_id
     WHERE ${where}`,
    params
  );

  const { total_debit: totalDebit, total_credit: totalCredit } = rows[0];
  return normalizeBalance(account.account_type, totalDebit, totalCredit);
}

module.exports = {
  postJournalEntry,
  reverseJournalEntry,
  requestPriorPeriodAdjustment,
  applyPriorPeriodAdjustmentApprovalDecision,
  postApprovedPriorPeriodAdjustment,
  registerGlExecutionHandlers,
  getAccountBalance,
  validateBalancedLines,
  normalizeBalance,
  GlPostingValidationError,
  UnbalancedEntryError,
  PeriodLockedError,
  GlPostingConflictError,
};
