'use strict';

const auditLog = require('../../shared/auditLog');
const approvalWorkflow = require('../../shared/approvalWorkflow');
const glPosting = require('../../shared/glPosting');

/**
 * Module 6: Cashier, Till & Vault Operations. Uses the Module 11/7 shared
 * services exactly as documented in Decisions_Log.md.
 *
 * No new GL control accounts: till float and cash-back both move cash
 * between the branch's EXISTING Cash in Hand and Vault sub-accounts
 * (Module 1). "The vault balance" for a branch IS
 * `branch_gl_accounts.vault_account_id`'s reconstructed GL balance — no
 * separate `vault_balances` table, despite the spec listing one. Same
 * reasoning, no separate `deleted_transactions_log` table — every write
 * already goes through the shared `audit_log` service and nothing is
 * ever hard-deleted. See Decisions_Log.md.
 *
 * GL mapping:
 *   Till open / cash-back   Dr Cash in Hand   Cr Vault
 *   Till close               Dr Vault          Cr Cash in Hand
 *   Reversal                 (glPosting.reverseJournalEntry — swaps the
 *                             original entry's own lines)
 *
 * Cash-back is threshold-gated maker-checker (same convention as Module
 * 4's savings.withdraw). Reversals ALWAYS require maker-checker (no
 * threshold — matches the spec's "with a reason code and approver").
 * Both follow the same two-phase shape every other approval-gated GL
 * posting in this codebase uses: the execution handler only records the
 * approval outcome inside decide()'s transaction (glPosting owns its own
 * transaction and can't run there); the actual GL posting happens
 * afterward via a separate explicit call.
 */

class CashierValidationError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 400;
  }
}
class CashierNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 404;
  }
}
class CashierConflictError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 409;
  }
}

const todayIso = () => new Date().toISOString().slice(0, 10);

/**
 * node-postgres returns DATE columns as JS Date objects, not
 * 'YYYY-MM-DD' strings (same trap documented in investmentService.js —
 * caught there in Module 5's smoke-testing, deliberately applied here
 * from the start). Every GL posting tied to a specific till must use
 * THAT till's own business_date, not "today" — otherwise closing a till
 * (or paying out its cash-back) misdates the entry to whenever the
 * action happens to be recorded, which can even spuriously collide with
 * a period lock that covers today but not the till's actual business
 * date.
 */
function toDateString(dateOrString) {
  if (dateOrString instanceof Date) return dateOrString.toISOString().slice(0, 10);
  return String(dateOrString).slice(0, 10);
}

async function getBranchGlAccounts(db, branchId) {
  const { rows } = await db.query('SELECT * FROM branch_gl_accounts WHERE branch_id = $1', [branchId]);
  if (!rows[0]) throw new CashierNotFoundError(`branch ${branchId} has no branch_gl_accounts row`);
  return rows[0];
}

/** A branch's day is locked once a 'day' close-out snapshot covers that date — blocks further till activity on it. */
async function assertDayNotLocked(db, { branchId, date }) {
  const { rows } = await db.query(
    `SELECT id FROM day_close_snapshots
      WHERE branch_id = $1 AND period_type = 'day' AND period_start <= $2 AND period_end >= $2`,
    [branchId, date]
  );
  if (rows.length > 0) {
    throw new CashierConflictError(`branch ${branchId}'s day-close for ${date} is already locked`);
  }
}

// --- Tills --------------------------------------------------------------------

async function getTill(pool, tillId) {
  const { rows } = await pool.query('SELECT * FROM cashier_tills WHERE id = $1', [tillId]);
  if (!rows[0]) throw new CashierNotFoundError(`cashier_till ${tillId} not found`);
  return rows[0];
}

async function listTills(pool, { branchId, cashierId, status } = {}) {
  const clauses = [];
  const params = [];
  const add = (col, val) => {
    if (val === undefined || val === null) return;
    params.push(val);
    clauses.push(`${col} = $${params.length}`);
  };
  add('branch_id', branchId);
  add('cashier_id', cashierId);
  add('status', status);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await pool.query(`SELECT * FROM cashier_tills ${where} ORDER BY opened_at DESC`, params);
  return rows;
}

/**
 * Opens a till: issues an opening float from the branch's vault (Dr Cash
 * in Hand / Cr Vault). A cashier may only have one open till at a time,
 * and the vault must actually hold enough to issue the float.
 */
async function openTill(pool, { branchId, cashierId, openingBalancePesewas, denominationBreakdownOpen = null, businessDate = todayIso(), openedBy }) {
  if (!branchId || !cashierId || !openedBy) {
    throw new CashierValidationError('branchId, cashierId, and openedBy are required');
  }
  if (!Number.isInteger(openingBalancePesewas) || openingBalancePesewas < 0) {
    throw new CashierValidationError('openingBalancePesewas must be a non-negative integer');
  }

  await assertDayNotLocked(pool, { branchId, date: businessDate });

  const { rows: existingRows } = await pool.query(
    "SELECT id FROM cashier_tills WHERE cashier_id = $1 AND status = 'open'",
    [cashierId]
  );
  if (existingRows.length > 0) {
    throw new CashierConflictError(`cashier ${cashierId} already has an open till (${existingRows[0].id})`);
  }

  const glAccounts = await getBranchGlAccounts(pool, branchId);
  let journalEntry = null;
  if (openingBalancePesewas > 0) {
    const vaultBalance = await glPosting.getAccountBalance(pool, {
      accountId: glAccounts.vault_account_id,
      branchId,
    });
    if (vaultBalance < openingBalancePesewas) {
      throw new CashierConflictError(
        `branch ${branchId}'s vault balance (${vaultBalance} pesewas) is insufficient to issue a ${openingBalancePesewas} pesewas float`
      );
    }

    journalEntry = await glPosting.postJournalEntry(pool, {
      branchId,
      reference: `TILL-OPEN-${cashierId}-${Date.now()}`,
      description: `Till opened for cashier ${cashierId}`,
      entryDate: businessDate,
      sourceModule: 'cashier',
      createdBy: openedBy,
      lines: [
        { accountId: glAccounts.cash_in_hand_account_id, debitPesewas: openingBalancePesewas, branchId },
        { accountId: glAccounts.vault_account_id, creditPesewas: openingBalancePesewas, branchId },
      ],
    });
  }

  const { rows } = await pool.query(
    `INSERT INTO cashier_tills
       (branch_id, cashier_id, business_date, opening_balance_pesewas, denomination_breakdown_open, opened_by, opening_journal_entry_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      branchId,
      cashierId,
      businessDate,
      openingBalancePesewas,
      denominationBreakdownOpen ? JSON.stringify(denominationBreakdownOpen) : null,
      openedBy,
      journalEntry ? journalEntry.id : null,
    ]
  );
  const till = rows[0];

  await auditLog.record(pool, {
    userId: openedBy,
    branchId,
    action: 'cashier.till_opened',
    entityType: 'cashier_till',
    entityId: till.id,
    afterState: till,
  });

  return { ...till, journalEntry };
}

/**
 * Closes a till: the cashier's physical count (`closingBalancePesewas`)
 * is banked back to the vault (Dr Vault / Cr Cash in Hand). Compares the
 * count against an "expected" balance — opening float plus every 'paid'
 * cash-back received — and records any variance rather than blocking on
 * it (a real-world shortage/surplus must be recorded, not hidden; see
 * Decisions_Log.md for why this can't be a true per-transaction
 * reconciliation).
 */
async function closeTill(pool, { tillId, closingBalancePesewas, denominationBreakdownClose = null, closedBy }) {
  if (!closedBy) throw new CashierValidationError('closedBy is required');
  if (!Number.isInteger(closingBalancePesewas) || closingBalancePesewas < 0) {
    throw new CashierValidationError('closingBalancePesewas must be a non-negative integer');
  }

  const till = await getTill(pool, tillId);
  if (till.status !== 'open') {
    throw new CashierConflictError(`cashier_till ${tillId} is not open (status: ${till.status})`);
  }

  const { rows: cashBackRows } = await pool.query(
    "SELECT COALESCE(SUM(amount_pesewas), 0) AS total FROM cash_back_requests WHERE till_id = $1 AND status = 'paid'",
    [tillId]
  );
  const expectedClosingBalance = Number(till.opening_balance_pesewas) + Number(cashBackRows[0].total);
  const variance = closingBalancePesewas - expectedClosingBalance;

  const glAccounts = await getBranchGlAccounts(pool, till.branch_id);
  let journalEntry = null;
  if (closingBalancePesewas > 0) {
    journalEntry = await glPosting.postJournalEntry(pool, {
      branchId: till.branch_id,
      reference: `TILL-CLOSE-${tillId}`,
      description: `Till ${tillId} closed for cashier ${till.cashier_id}`,
      entryDate: toDateString(till.business_date),
      sourceModule: 'cashier',
      createdBy: closedBy,
      lines: [
        { accountId: glAccounts.vault_account_id, debitPesewas: closingBalancePesewas, branchId: till.branch_id },
        { accountId: glAccounts.cash_in_hand_account_id, creditPesewas: closingBalancePesewas, branchId: till.branch_id },
      ],
    });
  }

  const { rows } = await pool.query(
    `UPDATE cashier_tills
        SET status = 'closed', closing_balance_pesewas = $1, expected_closing_balance_pesewas = $2,
            variance_pesewas = $3, denomination_breakdown_close = $4, closed_at = now(), closed_by = $5,
            closing_journal_entry_id = $6, updated_at = now()
      WHERE id = $7
      RETURNING *`,
    [
      closingBalancePesewas,
      expectedClosingBalance,
      variance,
      denominationBreakdownClose ? JSON.stringify(denominationBreakdownClose) : null,
      closedBy,
      journalEntry ? journalEntry.id : null,
      tillId,
    ]
  );
  const closed = rows[0];

  await auditLog.record(pool, {
    userId: closedBy,
    branchId: till.branch_id,
    action: 'cashier.till_closed',
    entityType: 'cashier_till',
    entityId: tillId,
    beforeState: { status: 'open' },
    afterState: { status: 'closed', closingBalancePesewas, expectedClosingBalance, variance },
  });

  return { ...closed, journalEntry };
}

// --- Cash-back requests (threshold-gated) --------------------------------------

async function resolveCashBackThreshold(db, branchId) {
  const thresholdRow = await approvalWorkflow.getApplicableThreshold(db, { actionType: 'cashback.request', branchId });
  return thresholdRow ? Number(thresholdRow.amount_threshold_pesewas) : 0;
}

/**
 * Requests a cash-back (additional float from the vault). Below the
 * configured threshold it pays out immediately; at/above it, queues for
 * maker-checker approval — same shape as Module 4's requestWithdrawal.
 */
async function requestCashBack(pool, { tillId, amountPesewas, requestedBy }) {
  if (!requestedBy) throw new CashierValidationError('requestedBy is required');
  if (!Number.isInteger(amountPesewas) || amountPesewas <= 0) {
    throw new CashierValidationError('amountPesewas must be a positive integer');
  }

  const till = await getTill(pool, tillId);
  if (till.status !== 'open') {
    throw new CashierConflictError(`cashier_till ${tillId} is not open (status: ${till.status})`);
  }

  const glAccounts = await getBranchGlAccounts(pool, till.branch_id);
  const vaultBalance = await glPosting.getAccountBalance(pool, { accountId: glAccounts.vault_account_id, branchId: till.branch_id });
  if (vaultBalance < amountPesewas) {
    throw new CashierConflictError(
      `branch ${till.branch_id}'s vault balance (${vaultBalance} pesewas) is insufficient for a ${amountPesewas} pesewas cash-back`
    );
  }

  const thresholdPesewas = await resolveCashBackThreshold(pool, till.branch_id);
  const needsApproval = approvalWorkflow.isApprovalRequired({ amount_threshold_pesewas: thresholdPesewas }, amountPesewas);

  if (!needsApproval) {
    const { rows } = await pool.query(
      `INSERT INTO cash_back_requests (till_id, amount_pesewas, threshold_flag, status, requested_by)
       VALUES ($1, $2, false, 'pending', $3) RETURNING *`,
      [tillId, amountPesewas, requestedBy]
    );
    return payOutCashBack(pool, { cashBackRequest: rows[0], paidBy: requestedBy });
  }

  const approvalRequest = await approvalWorkflow.requestApproval(pool, {
    actionType: 'cashback.request',
    entityType: 'cashier_till',
    entityId: tillId,
    branchId: till.branch_id,
    requestedBy,
    amountPesewas,
  });

  const { rows } = await pool.query(
    `INSERT INTO cash_back_requests (till_id, amount_pesewas, threshold_flag, approval_request_id, status, requested_by)
     VALUES ($1, $2, true, $3, 'pending', $4) RETURNING *`,
    [tillId, amountPesewas, approvalRequest.id, requestedBy]
  );

  return { cashBackRequest: rows[0], approvalRequest, paidOut: false, thresholdPesewas };
}

async function payOutCashBack(pool, { cashBackRequest, paidBy }) {
  const till = await getTill(pool, cashBackRequest.till_id);
  const glAccounts = await getBranchGlAccounts(pool, till.branch_id);
  const amountPesewas = Number(cashBackRequest.amount_pesewas);

  const journalEntry = await glPosting.postJournalEntry(pool, {
    branchId: till.branch_id,
    reference: `CASHBACK-${cashBackRequest.id}`,
    description: `Cash-back to till ${till.id}`,
    entryDate: toDateString(till.business_date),
    sourceModule: 'cashier',
    createdBy: paidBy,
    lines: [
      { accountId: glAccounts.cash_in_hand_account_id, debitPesewas: amountPesewas, branchId: till.branch_id },
      { accountId: glAccounts.vault_account_id, creditPesewas: amountPesewas, branchId: till.branch_id },
    ],
  });

  const { rows } = await pool.query(
    `UPDATE cash_back_requests SET status = 'paid', journal_entry_id = $1, updated_at = now() WHERE id = $2 RETURNING *`,
    [journalEntry.id, cashBackRequest.id]
  );

  await auditLog.record(pool, {
    userId: paidBy,
    branchId: till.branch_id,
    action: 'cashier.cashback_paid',
    entityType: 'cash_back_request',
    entityId: cashBackRequest.id,
    afterState: { amountPesewas, journalEntryId: journalEntry.id },
  });

  return { cashBackRequest: rows[0], paidOut: true, journalEntry };
}

/** Registered as the 'cashback.request' execution handler — records the approval outcome only; payout happens via settleApprovedCashBack. */
async function payOutCashBackOnApproval(approvalRequest, db) {
  const { rows } = await db.query('SELECT * FROM cash_back_requests WHERE approval_request_id = $1', [approvalRequest.id]);
  const cashBackRequest = rows[0];
  if (!cashBackRequest) throw new CashierNotFoundError(`no cash_back_requests row for approval_request ${approvalRequest.id}`);

  await auditLog.record(db, {
    userId: approvalRequest.decided_by,
    branchId: approvalRequest.branch_id,
    action: 'cashier.cashback_approved',
    entityType: 'cash_back_request',
    entityId: cashBackRequest.id,
    afterState: { approvalRequestId: approvalRequest.id },
  });
}

async function settleApprovedCashBack(pool, { cashBackRequestId, paidBy }) {
  const { rows } = await pool.query(
    `SELECT cbr.*, ar.status AS approval_status FROM cash_back_requests cbr
       LEFT JOIN approval_requests ar ON ar.id = cbr.approval_request_id
      WHERE cbr.id = $1`,
    [cashBackRequestId]
  );
  const cashBackRequest = rows[0];
  if (!cashBackRequest) throw new CashierNotFoundError(`cash_back_request ${cashBackRequestId} not found`);
  if (cashBackRequest.status === 'paid') throw new CashierConflictError(`cash_back_request ${cashBackRequestId} is already paid`);
  if (cashBackRequest.threshold_flag && cashBackRequest.approval_status !== 'approved') {
    throw new CashierConflictError(
      `cash_back_request ${cashBackRequestId} is not approved (approval status: ${cashBackRequest.approval_status})`
    );
  }
  return payOutCashBack(pool, { cashBackRequest, paidBy });
}

async function listCashBackRequests(pool, { tillId, status } = {}) {
  const clauses = [];
  const params = [];
  const add = (col, val) => {
    if (val === undefined || val === null) return;
    params.push(val);
    clauses.push(`${col} = $${params.length}`);
  };
  add('till_id', tillId);
  add('status', status);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await pool.query(`SELECT * FROM cash_back_requests ${where} ORDER BY created_at DESC`, params);
  return rows;
}

// --- Reversals (always maker-checker) -----------------------------------------

async function listReversals(pool, { branchId, status } = {}) {
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
  const { rows } = await pool.query(`SELECT * FROM transaction_reversals ${where} ORDER BY created_at DESC`, params);
  return rows;
}

async function requestReversal(pool, { originalJournalEntryId, reasonCode, notes = null, requestedBy }) {
  if (!originalJournalEntryId || !reasonCode || !requestedBy) {
    throw new CashierValidationError('originalJournalEntryId, reasonCode, and requestedBy are required');
  }

  const { rows: entryRows } = await pool.query('SELECT * FROM gl_journal_entries WHERE id = $1', [originalJournalEntryId]);
  const original = entryRows[0];
  if (!original) throw new CashierNotFoundError(`gl_journal_entries ${originalJournalEntryId} not found`);
  if (original.status !== 'posted') {
    throw new CashierConflictError(`gl_journal_entries ${originalJournalEntryId} is not posted (status: ${original.status})`);
  }

  const { rows: existingRows } = await pool.query(
    'SELECT id FROM transaction_reversals WHERE original_journal_entry_id = $1',
    [originalJournalEntryId]
  );
  if (existingRows.length > 0) {
    throw new CashierConflictError(`gl_journal_entries ${originalJournalEntryId} already has a reversal on record`);
  }

  const { rows: lineRows } = await pool.query(
    'SELECT COALESCE(SUM(debit_pesewas), 0) AS total FROM gl_journal_lines WHERE journal_entry_id = $1',
    [originalJournalEntryId]
  );

  const approvalRequest = await approvalWorkflow.requestApproval(pool, {
    actionType: 'gl.reversal',
    entityType: 'gl_journal_entry',
    entityId: originalJournalEntryId,
    branchId: original.branch_id,
    requestedBy,
    amountPesewas: Number(lineRows[0].total),
    payload: { reasonCode, notes },
  });

  const { rows } = await pool.query(
    `INSERT INTO transaction_reversals (branch_id, original_journal_entry_id, reason_code, notes, approval_request_id, requested_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [original.branch_id, originalJournalEntryId, reasonCode, notes, approvalRequest.id, requestedBy]
  );

  return { reversal: rows[0], approvalRequest };
}

/** Registered as the 'gl.reversal' execution handler — records the approval outcome only; the actual reversal happens via executeApprovedReversal. */
async function applyReversalApprovalDecision(approvalRequest, db) {
  const { rows: reversalRows } = await db.query(
    'SELECT * FROM transaction_reversals WHERE approval_request_id = $1 FOR UPDATE',
    [approvalRequest.id]
  );
  const reversal = reversalRows[0];
  if (!reversal) throw new CashierNotFoundError(`no transaction_reversals row for approval_request ${approvalRequest.id}`);

  const { rows } = await db.query(
    "UPDATE transaction_reversals SET status = 'approved', updated_at = now() WHERE id = $1 RETURNING *",
    [reversal.id]
  );

  await auditLog.record(db, {
    userId: approvalRequest.decided_by,
    branchId: approvalRequest.branch_id,
    action: 'cashier.reversal_approved',
    entityType: 'transaction_reversal',
    entityId: reversal.id,
    beforeState: { status: reversal.status },
    afterState: { status: rows[0].status },
  });
}

async function executeApprovedReversal(pool, { reversalId, executedBy }) {
  if (!executedBy) throw new CashierValidationError('executedBy is required');

  const { rows } = await pool.query('SELECT * FROM transaction_reversals WHERE id = $1', [reversalId]);
  const reversal = rows[0];
  if (!reversal) throw new CashierNotFoundError(`transaction_reversal ${reversalId} not found`);
  if (reversal.status !== 'approved') {
    throw new CashierConflictError(`transaction_reversal ${reversalId} is not approved (status: ${reversal.status})`);
  }

  const { reversalEntry } = await glPosting.reverseJournalEntry(pool, {
    originalEntryId: reversal.original_journal_entry_id,
    reason: `${reversal.reason_code}${reversal.notes ? ` — ${reversal.notes}` : ''}`,
    reversedBy: executedBy,
    entryDate: todayIso(),
  });

  const { rows: updatedRows } = await pool.query(
    `UPDATE transaction_reversals SET status = 'reversed', reversal_journal_entry_id = $1, updated_at = now() WHERE id = $2 RETURNING *`,
    [reversalEntry.id, reversalId]
  );

  await auditLog.record(pool, {
    userId: executedBy,
    branchId: reversal.branch_id,
    action: 'cashier.reversal_executed',
    entityType: 'transaction_reversal',
    entityId: reversalId,
    afterState: { reversalJournalEntryId: reversalEntry.id },
  });

  return { reversal: updatedRows[0], reversalEntry };
}

// --- Close-out (day/month/year) ------------------------------------------------

/** Shared precondition for every close-out level: no till in the branch may still be open. */
async function assertNoOpenTills(db, branchId) {
  const { rows } = await db.query(
    "SELECT id, cashier_id FROM cashier_tills WHERE branch_id = $1 AND status = 'open' ORDER BY id",
    [branchId]
  );
  if (rows.length > 0) {
    throw new CashierConflictError(
      `branch ${branchId} has open till(s) that must be closed first: ${rows.map((r) => `till ${r.id} (cashier ${r.cashier_id})`).join(', ')}`
    );
  }
}

/**
 * Runs a day/month/year close-out: blocks if any till in the branch is
 * still open, snapshots the branch's cash-in-hand and vault balances, and
 * — for 'month'/'year' — ALSO creates and locks the corresponding
 * gl_periods row, activating Module 7's period-lock mechanism for real
 * (nothing else in this codebase has ever created a gl_periods row —
 * see Decisions_Log.md). 'day' has no gl_periods equivalent; its lock is
 * enforced by cashierService itself (assertDayNotLocked), not glPosting.
 */
async function closeOutPeriod(pool, { branchId, periodType, periodStart, periodEnd, closedBy }) {
  if (!branchId || !periodType || !periodStart || !periodEnd || !closedBy) {
    throw new CashierValidationError('branchId, periodType, periodStart, periodEnd, and closedBy are required');
  }
  if (!['day', 'month', 'year'].includes(periodType)) {
    throw new CashierValidationError("periodType must be 'day', 'month', or 'year'");
  }

  await assertNoOpenTills(pool, branchId);

  const { rows: existingRows } = await pool.query(
    'SELECT id FROM day_close_snapshots WHERE branch_id = $1 AND period_type = $2 AND period_start = $3',
    [branchId, periodType, periodStart]
  );
  if (existingRows.length > 0) {
    throw new CashierConflictError(`branch ${branchId} already has a ${periodType} close-out for ${periodStart}`);
  }

  const glAccounts = await getBranchGlAccounts(pool, branchId);
  const [cashInHandBalance, vaultBalance] = await Promise.all([
    glPosting.getAccountBalance(pool, { accountId: glAccounts.cash_in_hand_account_id, branchId }),
    glPosting.getAccountBalance(pool, { accountId: glAccounts.vault_account_id, branchId }),
  ]);

  const { rows: tillsClosedRows } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM cashier_tills
      WHERE branch_id = $1 AND status = 'closed' AND business_date BETWEEN $2 AND $3`,
    [branchId, periodStart, periodEnd]
  );

  let glPeriodId = null;
  if (periodType === 'month' || periodType === 'year') {
    const { rows: periodRows } = await pool.query(
      `INSERT INTO gl_periods (branch_id, period_type, period_start, period_end, locked, locked_by, locked_at)
       VALUES ($1, $2, $3, $4, true, $5, now())
       RETURNING *`,
      [branchId, periodType, periodStart, periodEnd, closedBy]
    );
    glPeriodId = periodRows[0].id;
  }

  const { rows } = await pool.query(
    `INSERT INTO day_close_snapshots
       (branch_id, period_type, period_start, period_end, cash_in_hand_balance_pesewas, vault_balance_pesewas,
        tills_closed_count, gl_period_id, closed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [branchId, periodType, periodStart, periodEnd, cashInHandBalance, vaultBalance, tillsClosedRows[0].c, glPeriodId, closedBy]
  );
  const snapshot = rows[0];

  await auditLog.record(pool, {
    userId: closedBy,
    branchId,
    action: `cashier.${periodType}_closed`,
    entityType: 'day_close_snapshot',
    entityId: snapshot.id,
    afterState: snapshot,
  });

  return snapshot;
}

async function listCloseSnapshots(pool, { branchId, periodType } = {}) {
  const clauses = [];
  const params = [];
  const add = (col, val) => {
    if (val === undefined || val === null) return;
    params.push(val);
    clauses.push(`${col} = $${params.length}`);
  };
  add('branch_id', branchId);
  add('period_type', periodType);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await pool.query(`SELECT * FROM day_close_snapshots ${where} ORDER BY period_start DESC`, params);
  return rows;
}

// --- Cash position reporting ----------------------------------------------------

async function getBranchCashPosition(pool, branchId) {
  const glAccounts = await getBranchGlAccounts(pool, branchId);
  const [cashInHandBalance, vaultBalance] = await Promise.all([
    glPosting.getAccountBalance(pool, { accountId: glAccounts.cash_in_hand_account_id, branchId }),
    glPosting.getAccountBalance(pool, { accountId: glAccounts.vault_account_id, branchId }),
  ]);
  const openTills = await listTills(pool, { branchId, status: 'open' });
  const totalOpenTillFloatPesewas = openTills.reduce((sum, t) => sum + Number(t.opening_balance_pesewas), 0);

  return {
    branchId: Number(branchId),
    cashInHandBalancePesewas: cashInHandBalance,
    vaultBalancePesewas: vaultBalance,
    totalCashPositionPesewas: cashInHandBalance + vaultBalance,
    openTillCount: openTills.length,
    totalOpenTillFloatPesewas,
    openTills,
  };
}

async function getConsolidatedCashPosition(pool) {
  const { rows: branches } = await pool.query('SELECT id FROM branches ORDER BY id');
  const positions = await Promise.all(branches.map((b) => getBranchCashPosition(pool, b.id)));
  const totals = positions.reduce(
    (acc, p) => ({
      cashInHandBalancePesewas: acc.cashInHandBalancePesewas + p.cashInHandBalancePesewas,
      vaultBalancePesewas: acc.vaultBalancePesewas + p.vaultBalancePesewas,
      totalCashPositionPesewas: acc.totalCashPositionPesewas + p.totalCashPositionPesewas,
      openTillCount: acc.openTillCount + p.openTillCount,
    }),
    { cashInHandBalancePesewas: 0, vaultBalancePesewas: 0, totalCashPositionPesewas: 0, openTillCount: 0 }
  );

  return { branches: positions, totals };
}

/** Call once at app startup so decide() can dispatch cash-back/reversal approvals. */
function registerCashierExecutionHandlers() {
  approvalWorkflow.registerExecutionHandler('cashback.request', payOutCashBackOnApproval);
  approvalWorkflow.registerExecutionHandler('gl.reversal', applyReversalApprovalDecision);
}

module.exports = {
  openTill,
  closeTill,
  getTill,
  listTills,
  requestCashBack,
  payOutCashBack,
  payOutCashBackOnApproval,
  settleApprovedCashBack,
  listCashBackRequests,
  requestReversal,
  applyReversalApprovalDecision,
  executeApprovedReversal,
  listReversals,
  closeOutPeriod,
  listCloseSnapshots,
  getBranchCashPosition,
  getConsolidatedCashPosition,
  getBranchGlAccounts,
  registerCashierExecutionHandlers,
  CashierValidationError,
  CashierNotFoundError,
  CashierConflictError,
};
