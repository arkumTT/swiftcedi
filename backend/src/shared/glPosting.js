'use strict';

const auditLog = require('./auditLog');

/**
 * Shared GL posting interface (Module 7). No module writes to
 * `gl_journal_lines` directly — every module posts through
 * `postJournalEntry()`. The database also enforces the balanced-entry rule
 * and immutability at the trigger level (migration 007_gl_journal.sql) as
 * defense in depth, but the application-layer check here is what runs first
 * and gives callers a clear, typed error.
 */

class GlPostingValidationError extends Error {}
class UnbalancedEntryError extends GlPostingValidationError {}
class PeriodLockedError extends Error {}

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
  getAccountBalance,
  validateBalancedLines,
  normalizeBalance,
  GlPostingValidationError,
  UnbalancedEntryError,
  PeriodLockedError,
};
