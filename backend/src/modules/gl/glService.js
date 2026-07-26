'use strict';

const auditLog = require('../../shared/auditLog');
const approvalWorkflow = require('../../shared/approvalWorkflow');
const glPosting = require('../../shared/glPosting');

/**
 * Module 7: GL, Accounting & Financial Reporting. `glPosting.js` (under
 * `backend/src/shared/`) is the cross-module POSTING interface every
 * module calls into — this file is Module 7's OWN business logic: chart-
 * of-accounts admin, the financial statements, manual-JV maker-checker,
 * and bank reconciliation. Same split as every other module (e.g.
 * `approvalWorkflow.js`/`glPosting.js` are shared; `loanService.js` is
 * Module 3's own logic) — see Decisions_Log.md.
 */

class GlValidationError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 400;
  }
}
class GlNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 404;
  }
}
class GlConflictError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 409;
  }
}

const todayIso = () => new Date().toISOString().slice(0, 10);

// --- Chart of accounts --------------------------------------------------------

async function getGlAccount(db, accountId) {
  const { rows } = await db.query('SELECT * FROM gl_accounts WHERE id = $1', [accountId]);
  if (!rows[0]) throw new GlNotFoundError(`gl_account ${accountId} not found`);
  return rows[0];
}

async function listGlAccounts(pool, { branchId, accountType, status } = {}) {
  const clauses = [];
  const params = [];
  const add = (col, val) => {
    if (val === undefined || val === null) return;
    params.push(val);
    clauses.push(`${col} = $${params.length}`);
  };
  add('branch_id', branchId);
  add('account_type', accountType);
  add('status', status);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await pool.query(`SELECT * FROM gl_accounts ${where} ORDER BY code`, params);
  return rows;
}

/**
 * `actorBranchId` is the ACTING user's own home branch — used only for the
 * audit_log row (which requires a real branch_id FK) when this account
 * itself is org-wide (`branchId: null`), same fallback the original
 * inline `POST /gl/accounts` route logic used before it moved here.
 */
async function createGlAccount(pool, { code, name, accountType, branchId = null, parentAccountId = null, createdBy, actorBranchId }) {
  if (!code || !name || !accountType || !createdBy || !actorBranchId) {
    throw new GlValidationError('code, name, accountType, createdBy, and actorBranchId are required');
  }
  if (!['asset', 'liability', 'equity', 'income', 'expense'].includes(accountType)) {
    throw new GlValidationError("accountType must be one of 'asset', 'liability', 'equity', 'income', 'expense'");
  }

  const { rows } = await pool.query(
    `INSERT INTO gl_accounts (code, name, account_type, branch_id, parent_account_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [code, name, accountType, branchId, parentAccountId]
  );
  const account = rows[0];

  await auditLog.record(pool, {
    userId: createdBy,
    branchId: branchId || actorBranchId,
    action: 'gl.account_created',
    entityType: 'gl_account',
    entityId: account.id,
    afterState: account,
  });

  return account;
}

/**
 * Updates a GL account. `name` and `status` are always editable.
 * `code`/`accountType` may only change while the account has NO posted GL
 * activity yet (same "immutable once transactions exist" rule Module 1
 * applies to branch codes) — changing either after the fact would corrupt
 * every historical report's balance normalization.
 * `branchId`/`parentAccountId` are never editable — restructuring the CoA
 * hierarchy after the fact would silently change how existing history
 * rolls up in consolidated reports.
 * Deactivating (`status: 'inactive'`) requires a zero balance, same
 * "close/deactivate only at zero" rule every other module's closable
 * entity follows.
 */
async function updateGlAccount(pool, { accountId, updatedBy, actorBranchId, fields }) {
  if (!updatedBy || !actorBranchId) throw new GlValidationError('updatedBy and actorBranchId are required');
  if (!fields || Object.keys(fields).length === 0) {
    throw new GlValidationError('fields must include at least one change');
  }

  const client = await pool.connect();
  let account;
  try {
    await client.query('BEGIN');

    const { rows: beforeRows } = await client.query('SELECT * FROM gl_accounts WHERE id = $1 FOR UPDATE', [accountId]);
    const before = beforeRows[0];
    if (!before) throw new GlNotFoundError(`gl_account ${accountId} not found`);

    const setClauses = [];
    const params = [];

    if (fields.code !== undefined || fields.accountType !== undefined) {
      const { rows: activityRows } = await client.query('SELECT 1 FROM gl_journal_lines WHERE account_id = $1 LIMIT 1', [
        accountId,
      ]);
      if (activityRows.length > 0) {
        throw new GlConflictError(`gl_account ${accountId} has posted GL activity; code and accountType can no longer be changed`);
      }
    }
    if (fields.code !== undefined) {
      params.push(fields.code);
      setClauses.push(`code = $${params.length}`);
    }
    if (fields.accountType !== undefined) {
      if (!['asset', 'liability', 'equity', 'income', 'expense'].includes(fields.accountType)) {
        throw new GlValidationError("accountType must be one of 'asset', 'liability', 'equity', 'income', 'expense'");
      }
      params.push(fields.accountType);
      setClauses.push(`account_type = $${params.length}`);
    }
    if (fields.name !== undefined) {
      params.push(fields.name);
      setClauses.push(`name = $${params.length}`);
    }
    if (fields.status !== undefined) {
      if (!['active', 'inactive'].includes(fields.status)) {
        throw new GlValidationError("status must be 'active' or 'inactive'");
      }
      if (fields.status === 'inactive' && before.status !== 'inactive') {
        const balance = await glPosting.getAccountBalance(client, { accountId });
        if (balance !== 0) {
          throw new GlConflictError(`gl_account ${accountId} cannot be deactivated with a non-zero balance (${balance} pesewas)`);
        }
      }
      params.push(fields.status);
      setClauses.push(`status = $${params.length}`);
    }

    if (setClauses.length === 0) {
      throw new GlValidationError('no recognized fields to update (name, status, code, accountType)');
    }

    params.push(accountId);
    const { rows: updatedRows } = await client.query(
      `UPDATE gl_accounts SET ${setClauses.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`,
      params
    );
    account = updatedRows[0];

    await auditLog.record(client, {
      userId: updatedBy,
      branchId: account.branch_id || actorBranchId,
      action: 'gl.account_updated',
      entityType: 'gl_account',
      entityId: accountId,
      beforeState: before,
      afterState: account,
    });

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return account;
}

// --- Financial statements ------------------------------------------------------

/**
 * The one query every financial statement below is built on: per-control-
 * account totals (debit/credit), reconstructed from `gl_journal_lines`
 * directly — never a running balance — for either a point in time
 * (`asOfDate`, cumulative since inception) or a period (`fromDate`..
 * `toDate`).
 *
 * "Control account" rollup: every account maps to
 * `COALESCE(parent_account_id, id)` — a branch's own sub-account
 * (e.g. `1000.NRA-01`) rolls up into its org-wide control row
 * (`1000`), exactly the roll-up Decisions_Log's Chart of Accounts
 * section describes. When `branchId` is given, the WHERE clause
 * restricts to that branch's own accounts, which makes the "roll-up" a
 * no-op (one sub-account per control per branch) and yields a branch-
 * level statement; omitting it aggregates every branch under each
 * control row for a consolidated statement. Zero-activity accounts
 * still appear (LEFT JOIN), matching standard trial-balance convention.
 */
async function getAccountRollup(pool, { asOfDate = null, fromDate = null, toDate = null, branchId = null, accountTypes = null }) {
  if (!asOfDate && !(fromDate && toDate)) {
    throw new GlValidationError('either asOfDate or both fromDate and toDate are required');
  }

  const dateParams = [];
  let dateWhere;
  if (asOfDate) {
    dateParams.push(asOfDate);
    dateWhere = `e.entry_date <= $${dateParams.length}`;
  } else {
    dateParams.push(fromDate);
    dateWhere = `e.entry_date >= $${dateParams.length}`;
    dateParams.push(toDate);
    dateWhere += ` AND e.entry_date <= $${dateParams.length}`;
  }

  const { rows: activity } = await pool.query(
    `SELECT l.account_id, COALESCE(SUM(l.debit_pesewas), 0) AS debit, COALESCE(SUM(l.credit_pesewas), 0) AS credit
       FROM gl_journal_lines l
       JOIN gl_journal_entries e ON e.id = l.journal_entry_id
      WHERE ${dateWhere}
      GROUP BY l.account_id`,
    dateParams
  );
  const activityByAccountId = new Map(activity.map((r) => [Number(r.account_id), r]));

  const scopeParams = [];
  let scopeWhere = '';
  if (branchId) {
    scopeParams.push(branchId);
    scopeWhere = `WHERE ga.branch_id = $${scopeParams.length}`;
  }
  if (accountTypes && accountTypes.length > 0) {
    scopeParams.push(accountTypes);
    scopeWhere += `${scopeWhere ? ' AND' : 'WHERE'} ctrl.account_type = ANY($${scopeParams.length})`;
  }

  const { rows: accounts } = await pool.query(
    `SELECT ga.id, COALESCE(ga.parent_account_id, ga.id) AS control_id,
            ctrl.code AS control_code, ctrl.name AS control_name, ctrl.account_type
       FROM gl_accounts ga
       JOIN gl_accounts ctrl ON ctrl.id = COALESCE(ga.parent_account_id, ga.id)
       ${scopeWhere}`,
    scopeParams
  );

  const byControl = new Map();
  for (const row of accounts) {
    const key = Number(row.control_id);
    if (!byControl.has(key)) {
      byControl.set(key, {
        accountId: key,
        code: row.control_code,
        name: row.control_name,
        accountType: row.account_type,
        totalDebitPesewas: 0,
        totalCreditPesewas: 0,
      });
    }
    const entry = byControl.get(key);
    const act = activityByAccountId.get(Number(row.id));
    if (act) {
      entry.totalDebitPesewas += Number(act.debit);
      entry.totalCreditPesewas += Number(act.credit);
    }
  }

  return [...byControl.values()]
    .map((entry) => ({
      ...entry,
      balancePesewas: glPosting.normalizeBalance(entry.accountType, entry.totalDebitPesewas, entry.totalCreditPesewas),
    }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

const DEBIT_NORMAL_TYPES = new Set(['asset', 'expense']);

/**
 * Splits a normalized balance (positive = normal side, negative = an
 * abnormal contra balance) into separate debit/credit columns for
 * display — the shape a trial balance is conventionally printed in.
 */
function toDebitCreditColumns(accountType, balancePesewas) {
  const isDebitNormal = DEBIT_NORMAL_TYPES.has(accountType);
  if (balancePesewas >= 0) {
    return isDebitNormal ? { debitPesewas: balancePesewas, creditPesewas: 0 } : { debitPesewas: 0, creditPesewas: balancePesewas };
  }
  return isDebitNormal ? { debitPesewas: 0, creditPesewas: -balancePesewas } : { debitPesewas: -balancePesewas, creditPesewas: 0 };
}

/**
 * Trial balance: every control account's balance as of a date, debit-
 * normal balances in the debit column and credit-normal in the credit
 * column. Total debits must equal total credits for the ledger as a
 * whole — the report exposes this as `balanced` so a caller can flag a
 * discrepancy immediately rather than trusting the number silently.
 */
async function getTrialBalance(pool, { asOfDate = todayIso(), branchId = null } = {}) {
  const rollup = await getAccountRollup(pool, { asOfDate, branchId });
  const lines = rollup.map((r) => {
    const { debitPesewas, creditPesewas } = toDebitCreditColumns(r.accountType, r.balancePesewas);
    return { accountId: r.accountId, code: r.code, name: r.name, accountType: r.accountType, debitPesewas, creditPesewas };
  });
  const totalDebitPesewas = lines.reduce((s, l) => s + l.debitPesewas, 0);
  const totalCreditPesewas = lines.reduce((s, l) => s + l.creditPesewas, 0);

  return {
    asOfDate,
    branchId: branchId ? Number(branchId) : null,
    lines,
    totalDebitPesewas,
    totalCreditPesewas,
    balanced: totalDebitPesewas === totalCreditPesewas,
  };
}

/**
 * Balance sheet: assets / liabilities / equity as of a date. Since
 * nothing in this codebase formally closes income/expense into a
 * retained-earnings equity account at period-end, "Net Income (current
 * period)" is computed here as a plug — income minus expense, same
 * as-of date and scope — and shown as its own equity line. This is what
 * makes `Assets = Liabilities + Equity` hold by construction: it's the
 * fundamental accounting identity, not an approximation, as long as
 * every posted entry balanced (which glPosting.js already guarantees).
 */
async function getBalanceSheet(pool, { asOfDate = todayIso(), branchId = null } = {}) {
  const rollup = await getAccountRollup(pool, { asOfDate, branchId });

  const assets = rollup.filter((r) => r.accountType === 'asset');
  const liabilities = rollup.filter((r) => r.accountType === 'liability');
  const equity = rollup.filter((r) => r.accountType === 'equity');
  const income = rollup.filter((r) => r.accountType === 'income');
  const expense = rollup.filter((r) => r.accountType === 'expense');

  const sum = (rows) => rows.reduce((s, r) => s + r.balancePesewas, 0);
  const totalAssetsPesewas = sum(assets);
  const totalLiabilitiesPesewas = sum(liabilities);
  const totalEquityPesewas = sum(equity);
  const netIncomePesewas = sum(income) - sum(expense);
  const totalEquityAndNetIncomePesewas = totalEquityPesewas + netIncomePesewas;

  return {
    asOfDate,
    branchId: branchId ? Number(branchId) : null,
    assets,
    liabilities,
    equity,
    totalAssetsPesewas,
    totalLiabilitiesPesewas,
    totalEquityPesewas,
    netIncomePesewas,
    totalEquityAndNetIncomePesewas,
    balanced: totalAssetsPesewas === totalLiabilitiesPesewas + totalEquityAndNetIncomePesewas,
  };
}

/**
 * Income statement: income and expense activity for a PERIOD
 * (`fromDate`..`toDate`), not a point in time — income/expense are flow
 * accounts, so this is period activity, not a cumulative balance.
 */
async function getIncomeStatement(pool, { fromDate, toDate, branchId = null }) {
  if (!fromDate || !toDate) throw new GlValidationError('fromDate and toDate are required');

  const rollup = await getAccountRollup(pool, { fromDate, toDate, branchId, accountTypes: ['income', 'expense'] });
  const income = rollup.filter((r) => r.accountType === 'income');
  const expense = rollup.filter((r) => r.accountType === 'expense');
  const totalIncomePesewas = income.reduce((s, r) => s + r.balancePesewas, 0);
  const totalExpensePesewas = expense.reduce((s, r) => s + r.balancePesewas, 0);

  return {
    fromDate,
    toDate,
    branchId: branchId ? Number(branchId) : null,
    income,
    expense,
    totalIncomePesewas,
    totalExpensePesewas,
    netIncomePesewas: totalIncomePesewas - totalExpensePesewas,
  };
}

/** A daily balance summary is just a trial balance as of that single day. */
async function getDailyBalanceSummary(pool, { date = todayIso(), branchId = null } = {}) {
  return getTrialBalance(pool, { asOfDate: date, branchId });
}

/**
 * End-of-year transaction report: every journal entry (with its lines)
 * posted in a given year, for a branch or consolidated. This is the
 * detail report a trial balance's totals should tie back to.
 */
async function getAnnualTransactionReport(pool, { year, branchId = null }) {
  if (!Number.isInteger(year)) throw new GlValidationError('year must be an integer');

  const params = [`${year}-01-01`, `${year}-12-31`];
  let where = 'e.entry_date >= $1 AND e.entry_date <= $2';
  if (branchId) {
    params.push(branchId);
    where += ` AND e.branch_id = $${params.length}`;
  }

  const { rows: entries } = await pool.query(
    `SELECT e.* FROM gl_journal_entries e WHERE ${where} ORDER BY e.entry_date, e.id`,
    params
  );
  const entryIds = entries.map((e) => e.id);
  const linesByEntry = new Map();
  if (entryIds.length > 0) {
    const { rows: lines } = await pool.query('SELECT * FROM gl_journal_lines WHERE journal_entry_id = ANY($1)', [entryIds]);
    for (const line of lines) {
      const key = Number(line.journal_entry_id);
      if (!linesByEntry.has(key)) linesByEntry.set(key, []);
      linesByEntry.get(key).push(line);
    }
  }

  return {
    year,
    branchId: branchId ? Number(branchId) : null,
    entries: entries.map((e) => ({ ...e, lines: linesByEntry.get(Number(e.id)) || [] })),
    entryCount: entries.length,
  };
}

/**
 * A paginated, filterable list of posted journal entries — the closest
 * thing this codebase has to a single "unified transaction ledger," since
 * every module's financial action (loan disbursement/repayment, savings
 * deposit/withdrawal, susu collection/commission, investment activation/
 * payout, cashier reversals) posts through the shared `glPosting.js`
 * interface and therefore always has a row here. Added specifically to
 * back the frontend's Transactions screen and dashboard recent-activity
 * widget — see Decisions_Log.md. `amountPesewas` is each entry's total
 * debit-side value (== credit-side, since every entry balances), which is
 * the one meaningful "how much moved" figure for a list view; the
 * `reference` string's suffix (e.g. -RPY, -DISB, -DEP, -WDL, -COL, -COMM)
 * is what the frontend groups into Collections/Payouts/Commissions
 * filter chips, following the naming convention every module's own
 * posting code already uses — no new column needed.
 */
async function listJournalEntries(pool, { branchId, sourceModule, fromDate, toDate, limit = 50, offset = 0 } = {}) {
  const clauses = [];
  const params = [];
  const add = (col, val) => {
    if (val === undefined || val === null || val === '') return;
    params.push(val);
    clauses.push(`${col} = $${params.length}`);
  };
  add('e.branch_id', branchId);
  add('e.source_module', sourceModule);
  if (fromDate) {
    params.push(fromDate);
    clauses.push(`e.entry_date >= $${params.length}`);
  }
  if (toDate) {
    params.push(toDate);
    clauses.push(`e.entry_date <= $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  params.push(Math.min(Number(limit) || 50, 200));
  const limitIdx = params.length;
  params.push(Number(offset) || 0);
  const offsetIdx = params.length;

  const { rows } = await pool.query(
    `SELECT e.*, COALESCE((SELECT SUM(l.debit_pesewas) FROM gl_journal_lines l WHERE l.journal_entry_id = e.id), 0)::bigint AS amount_pesewas
       FROM gl_journal_entries e
       ${where}
      ORDER BY e.entry_date DESC, e.id DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params
  );
  return rows;
}

/**
 * The transaction-drill-down counterpart to listJournalEntries — the
 * ledger list shows one net amount per entry; this returns the entry's
 * actual debit/credit lines (account code/name joined for readability) so
 * a "detailed transaction record" screen can show what actually moved.
 */
async function getJournalEntryDetail(pool, { journalEntryId }) {
  const { rows: entryRows } = await pool.query('SELECT * FROM gl_journal_entries WHERE id = $1', [journalEntryId]);
  const entry = entryRows[0];
  if (!entry) throw new GlNotFoundError(`gl_journal_entries ${journalEntryId} not found`);

  const { rows: lines } = await pool.query(
    `SELECT l.*, a.code AS account_code, a.name AS account_name
       FROM gl_journal_lines l
       JOIN gl_accounts a ON a.id = l.account_id
      WHERE l.journal_entry_id = $1
      ORDER BY l.id`,
    [journalEntryId]
  );
  return { entry, lines };
}

// --- Manual JV (always maker-checker) -----------------------------------------

/**
 * Requests a manual JV — ALWAYS goes through maker-checker (see the
 * migration comment for why). Validates the lines balance up front
 * (`glPosting.validateBalancedLines`) so a doomed-to-fail entry is never
 * even submitted for approval, then snapshots them on the
 * `gl_manual_entries` row so what eventually posts can never silently
 * drift from what a checker reviewed.
 */
async function requestManualJournalEntry(pool, { branchId, entryDate, description, lines, requestedBy }) {
  if (!branchId || !entryDate || !description || !requestedBy) {
    throw new GlValidationError('branchId, entryDate, description, and requestedBy are required');
  }
  const { totalDebit } = glPosting.validateBalancedLines(lines);

  const { rows } = await pool.query(
    `INSERT INTO gl_manual_entries (branch_id, entry_date, description, lines, requested_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [branchId, entryDate, description, JSON.stringify(lines), requestedBy]
  );
  const entry = rows[0];

  const approvalRequest = await approvalWorkflow.requestApproval(pool, {
    actionType: 'gl.manual_jv',
    entityType: 'gl_manual_entry',
    entityId: entry.id,
    branchId,
    requestedBy,
    amountPesewas: totalDebit,
  });

  const { rows: updatedRows } = await pool.query(
    'UPDATE gl_manual_entries SET approval_request_id = $1, updated_at = now() WHERE id = $2 RETURNING *',
    [approvalRequest.id, entry.id]
  );

  return { entry: updatedRows[0], approvalRequest };
}

/**
 * Registered as the 'gl.manual_jv' execution handler — only flips the
 * entry to `approved` here; the actual posting happens afterward via
 * `postApprovedManualJournalEntry` (`postJournalEntry` owns its own
 * transaction, same two-phase shape as every other approval-gated GL
 * posting in this codebase).
 */
async function applyManualJournalEntryApprovalDecision(approvalRequest, db) {
  const { rows: entryRows } = await db.query(
    'SELECT * FROM gl_manual_entries WHERE approval_request_id = $1 FOR UPDATE',
    [approvalRequest.id]
  );
  const entry = entryRows[0];
  if (!entry) throw new GlNotFoundError(`no gl_manual_entries row for approval_request ${approvalRequest.id}`);

  const { rows } = await db.query(
    "UPDATE gl_manual_entries SET status = 'approved', updated_at = now() WHERE id = $1 RETURNING *",
    [entry.id]
  );

  await auditLog.record(db, {
    userId: approvalRequest.decided_by,
    branchId: approvalRequest.branch_id,
    action: 'gl.manual_jv_approved',
    entityType: 'gl_manual_entry',
    entityId: entry.id,
    beforeState: { status: entry.status },
    afterState: { status: rows[0].status },
  });
}

/**
 * Posts an approved manual JV as an ordinary `entryType: 'standard'`
 * entry. If the target period has since been locked, `postJournalEntry`
 * itself throws `PeriodLockedError` — a manual JV must NOT silently
 * become a prior-period adjustment; the requester should use the
 * dedicated `glPosting.requestPriorPeriodAdjustment` workflow instead.
 */
async function postApprovedManualJournalEntry(pool, { entryId, postedBy }) {
  const { rows } = await pool.query('SELECT * FROM gl_manual_entries WHERE id = $1', [entryId]);
  const entry = rows[0];
  if (!entry) throw new GlNotFoundError(`gl_manual_entries ${entryId} not found`);
  if (entry.status !== 'approved') {
    throw new GlConflictError(`gl_manual_entries ${entryId} is not approved (status: ${entry.status})`);
  }

  const journalEntry = await glPosting.postJournalEntry(pool, {
    branchId: entry.branch_id,
    reference: `JV-${entryId}`,
    description: entry.description,
    entryDate: entry.entry_date,
    sourceModule: 'gl_manual_entry',
    createdBy: postedBy,
    entryType: 'standard',
    lines: entry.lines,
  });

  const { rows: updatedRows } = await pool.query(
    "UPDATE gl_manual_entries SET status = 'posted', journal_entry_id = $1, updated_at = now() WHERE id = $2 RETURNING *",
    [journalEntry.id, entryId]
  );

  return { entry: updatedRows[0], journalEntry };
}

/** Call once at app startup so decide() can dispatch manual-JV approvals. */
function registerGlModuleExecutionHandlers() {
  approvalWorkflow.registerExecutionHandler('gl.manual_jv', applyManualJournalEntryApprovalDecision);
}

// --- Bank reconciliation --------------------------------------------------------

/**
 * Registers an existing GL asset account as a reconcilable bank account.
 * The account itself must already exist (created via the ordinary
 * chart-of-accounts endpoints) — this only links it into the
 * reconciliation module, it does not create GL structure.
 */
async function createBankAccount(pool, { glAccountId, branchId = null, bankName, accountNumber, createdBy, actorBranchId }) {
  if (!glAccountId || !bankName || !accountNumber || !createdBy || !actorBranchId) {
    throw new GlValidationError('glAccountId, bankName, accountNumber, createdBy, and actorBranchId are required');
  }

  const account = await getGlAccount(pool, glAccountId);
  if (account.account_type !== 'asset') {
    throw new GlValidationError(`gl_account ${glAccountId} must be an asset account to be reconciled as a bank account`);
  }

  const { rows } = await pool.query(
    `INSERT INTO bank_accounts (gl_account_id, branch_id, bank_name, account_number, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [glAccountId, branchId, bankName, accountNumber, createdBy]
  );
  const bankAccount = rows[0];

  await auditLog.record(pool, {
    userId: createdBy,
    branchId: branchId || actorBranchId,
    action: 'gl.bank_account_created',
    entityType: 'bank_account',
    entityId: bankAccount.id,
    afterState: bankAccount,
  });

  return bankAccount;
}

async function listBankAccounts(pool, { branchId, status } = {}) {
  const clauses = [];
  const params = [];
  const add = (col, val) => {
    if (val === undefined || val === null) return;
    params.push(val);
    clauses.push(`${col} = $${params.length}`);
  };
  add('branch_id', branchId);
  add('status', status);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await pool.query(`SELECT * FROM bank_accounts ${where} ORDER BY bank_name`, params);
  return rows;
}

/**
 * Bulk-imports statement lines for a bank account. Recorded as a single
 * audit_log entry summarizing the batch (count + date range) rather than
 * one per line — the lines themselves are external bank data, not this
 * institution's own financial transactions, so they don't need the
 * per-row before/after trail a GL/account write does.
 */
async function importStatementLines(pool, { bankAccountId, lines, uploadedBy, actorBranchId }) {
  if (!bankAccountId || !uploadedBy || !actorBranchId) {
    throw new GlValidationError('bankAccountId, uploadedBy, and actorBranchId are required');
  }
  if (!Array.isArray(lines) || lines.length === 0) throw new GlValidationError('lines must be a non-empty array');
  for (const line of lines) {
    if (!line.statementDate || !line.description || !Number.isInteger(line.amountPesewas) || line.amountPesewas === 0) {
      throw new GlValidationError('each line requires statementDate, description, and a non-zero integer amountPesewas');
    }
  }

  const client = await pool.connect();
  let inserted;
  try {
    await client.query('BEGIN');

    const { rows: bankAccountRows } = await client.query('SELECT * FROM bank_accounts WHERE id = $1', [bankAccountId]);
    const bankAccount = bankAccountRows[0];
    if (!bankAccount) throw new GlNotFoundError(`bank_account ${bankAccountId} not found`);

    inserted = [];
    for (const line of lines) {
      const { rows } = await client.query(
        `INSERT INTO bank_statement_lines (bank_account_id, statement_date, description, amount_pesewas, external_reference, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [bankAccountId, line.statementDate, line.description, line.amountPesewas, line.externalReference || null, uploadedBy]
      );
      inserted.push(rows[0]);
    }

    await auditLog.record(client, {
      userId: uploadedBy,
      branchId: bankAccount.branch_id || actorBranchId,
      action: 'gl.bank_statement_lines_imported',
      entityType: 'bank_account',
      entityId: bankAccountId,
      afterState: { importedCount: inserted.length },
    });

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return inserted;
}

/**
 * Matches one statement line to one of this institution's own GL journal
 * lines on the same bank account. The journal line's net debit
 * (debit_pesewas - credit_pesewas, correct since a bank account is a
 * debit-normal asset) must equal the statement line's signed amount
 * exactly — a reconciliation match is never a "close enough" fuzzy match.
 */
async function matchStatementLine(pool, { statementLineId, journalLineId, matchedBy, actorBranchId }) {
  if (!statementLineId || !journalLineId || !matchedBy || !actorBranchId) {
    throw new GlValidationError('statementLineId, journalLineId, matchedBy, and actorBranchId are required');
  }

  const client = await pool.connect();
  let statementLine;
  try {
    await client.query('BEGIN');

    const { rows: lineRows } = await client.query('SELECT * FROM bank_statement_lines WHERE id = $1 FOR UPDATE', [
      statementLineId,
    ]);
    const before = lineRows[0];
    if (!before) throw new GlNotFoundError(`bank_statement_line ${statementLineId} not found`);
    if (before.status === 'matched') throw new GlConflictError(`bank_statement_line ${statementLineId} is already matched`);

    const { rows: bankAccountRows } = await client.query('SELECT * FROM bank_accounts WHERE id = $1', [
      before.bank_account_id,
    ]);
    const bankAccount = bankAccountRows[0];

    const { rows: journalLineRows } = await client.query('SELECT * FROM gl_journal_lines WHERE id = $1', [journalLineId]);
    const journalLine = journalLineRows[0];
    if (!journalLine) throw new GlNotFoundError(`gl_journal_line ${journalLineId} not found`);
    if (Number(journalLine.account_id) !== Number(bankAccount.gl_account_id)) {
      throw new GlValidationError(`gl_journal_line ${journalLineId} is not posted to this bank account's GL account`);
    }
    const netDebit = Number(journalLine.debit_pesewas) - Number(journalLine.credit_pesewas);
    if (netDebit !== Number(before.amount_pesewas)) {
      throw new GlValidationError(
        `gl_journal_line ${journalLineId} net amount (${netDebit}) does not match statement line amount (${before.amount_pesewas})`
      );
    }

    const { rows: updatedRows } = await client.query(
      "UPDATE bank_statement_lines SET status = 'matched', matched_journal_line_id = $1, updated_at = now() WHERE id = $2 RETURNING *",
      [journalLineId, statementLineId]
    );
    statementLine = updatedRows[0];

    await auditLog.record(client, {
      userId: matchedBy,
      branchId: bankAccount.branch_id || actorBranchId,
      action: 'gl.bank_statement_line_matched',
      entityType: 'bank_statement_line',
      entityId: statementLineId,
      beforeState: before,
      afterState: statementLine,
    });

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return statementLine;
}

/**
 * Standard two-sided bank reconciliation as of a date: the GL (book)
 * balance is adjusted upward by statement lines the bank has recorded but
 * this institution hasn't yet posted (bank fees, interest credited); the
 * statement balance is adjusted upward by this institution's own posted
 * journal lines the bank hasn't cleared yet (deposits in transit,
 * outstanding withdrawals). These adjusted figures are reported for
 * context (the cash position once every outstanding item clears as
 * expected) but are NOT the reconciled check — they always agree with
 * each other by construction (every match is validated to have equal
 * amounts, so whatever's "left over" nets out identically no matter what
 * glBalance/statementBalance actually are, even a wildly wrong one).
 * `reconciled` instead means what the term actually means: every
 * transaction on both sides has been tied to its counterpart, i.e. no
 * outstanding items remain unexplained as of this date.
 */
async function getBankReconciliation(pool, { bankAccountId, asOfDate = todayIso() }) {
  if (!bankAccountId) throw new GlValidationError('bankAccountId is required');

  const { rows: bankAccountRows } = await pool.query('SELECT * FROM bank_accounts WHERE id = $1', [bankAccountId]);
  const bankAccount = bankAccountRows[0];
  if (!bankAccount) throw new GlNotFoundError(`bank_account ${bankAccountId} not found`);

  const glBalancePesewas = await glPosting.getAccountBalance(pool, { accountId: bankAccount.gl_account_id, asOfDate });

  const { rows: statementLines } = await pool.query(
    'SELECT * FROM bank_statement_lines WHERE bank_account_id = $1 AND statement_date <= $2 ORDER BY statement_date, id',
    [bankAccountId, asOfDate]
  );
  const statementBalancePesewas = statementLines.reduce((s, l) => s + Number(l.amount_pesewas), 0);
  const unmatchedStatementLines = statementLines.filter((l) => l.status === 'unmatched');

  const matchedJournalLineIds = statementLines.filter((l) => l.matched_journal_line_id).map((l) => l.matched_journal_line_id);
  const { rows: allJournalLines } = await pool.query(
    `SELECT l.* FROM gl_journal_lines l
       JOIN gl_journal_entries e ON e.id = l.journal_entry_id
      WHERE l.account_id = $1 AND e.entry_date <= $2`,
    [bankAccount.gl_account_id, asOfDate]
  );
  const matchedSet = new Set(matchedJournalLineIds.map(Number));
  const unmatchedJournalLines = allJournalLines.filter((l) => !matchedSet.has(Number(l.id)));

  const unmatchedStatementTotalPesewas = unmatchedStatementLines.reduce((s, l) => s + Number(l.amount_pesewas), 0);
  const unmatchedJournalTotalPesewas = unmatchedJournalLines.reduce(
    (s, l) => s + (Number(l.debit_pesewas) - Number(l.credit_pesewas)),
    0
  );

  const adjustedGlBalancePesewas = glBalancePesewas + unmatchedStatementTotalPesewas;
  const adjustedStatementBalancePesewas = statementBalancePesewas + unmatchedJournalTotalPesewas;

  return {
    bankAccountId: Number(bankAccountId),
    asOfDate,
    glBalancePesewas,
    statementBalancePesewas,
    outstandingOnStatementNotInGl: unmatchedStatementLines,
    outstandingInGlNotOnStatement: unmatchedJournalLines,
    adjustedGlBalancePesewas,
    adjustedStatementBalancePesewas,
    reconciled: unmatchedStatementLines.length === 0 && unmatchedJournalLines.length === 0,
  };
}

module.exports = {
  getGlAccount,
  listGlAccounts,
  createGlAccount,
  updateGlAccount,
  getAccountRollup,
  getTrialBalance,
  getBalanceSheet,
  getIncomeStatement,
  getDailyBalanceSummary,
  getAnnualTransactionReport,
  listJournalEntries,
  getJournalEntryDetail,
  requestManualJournalEntry,
  applyManualJournalEntryApprovalDecision,
  postApprovedManualJournalEntry,
  registerGlModuleExecutionHandlers,
  createBankAccount,
  listBankAccounts,
  importStatementLines,
  matchStatementLine,
  getBankReconciliation,
  GlValidationError,
  GlNotFoundError,
  GlConflictError,
};
