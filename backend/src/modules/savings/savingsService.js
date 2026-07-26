'use strict';

const auditLog = require('../../shared/auditLog');
const approvalWorkflow = require('../../shared/approvalWorkflow');
const glPosting = require('../../shared/glPosting');
const savingsMath = require('./savingsMath');

/**
 * Module 4: Savings & Deposits. Uses the Module 11/7 shared services
 * exactly as documented in Decisions_Log.md — above-threshold withdrawals
 * are maker-checker gated via approvalWorkflow.registerExecutionHandler,
 * the same pattern Modules 1/2/3 use.
 *
 * GL mapping (see Decisions_Log.md):
 *   Deposit      Dr Cash in Hand        Cr Customer Deposits
 *   Withdrawal   Dr Customer Deposits   Cr Cash in Hand
 *   Charge/fee   Dr Customer Deposits   Cr Savings Fee Income
 * Customer Deposits is a LIABILITY — the money is owed back to the
 * customer — which is why a deposit credits it and a withdrawal debits it.
 */

class SavingsValidationError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 400;
  }
}
class SavingsNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 404;
  }
}
class SavingsConflictError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 409;
  }
}

const todayIso = () => new Date().toISOString().slice(0, 10);

// --- Products ---------------------------------------------------------------

async function createSavingsProduct(pool, params) {
  const {
    name,
    code,
    minBalancePesewas = 0,
    maintenanceFeePesewas = 0,
    withdrawalFeePesewas = 0,
    minBalanceChargePesewas = 0,
    withdrawalApprovalThresholdPesewas = 0,
    allowsOverdraft = false,
    createdBy,
  } = params;
  if (!name || !code || !createdBy) throw new SavingsValidationError('name, code, and createdBy are required');

  const { rows } = await pool.query(
    `INSERT INTO savings_products
       (name, code, min_balance_pesewas, maintenance_fee_pesewas, withdrawal_fee_pesewas,
        min_balance_charge_pesewas, withdrawal_approval_threshold_pesewas, allows_overdraft, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [
      name,
      String(code).toUpperCase(),
      minBalancePesewas,
      maintenanceFeePesewas,
      withdrawalFeePesewas,
      minBalanceChargePesewas,
      withdrawalApprovalThresholdPesewas,
      allowsOverdraft,
      createdBy,
    ]
  );
  return rows[0];
}

async function listSavingsProducts(pool, { status } = {}) {
  const params = [];
  let where = '';
  if (status) {
    params.push(status);
    where = 'WHERE status = $1';
  }
  const { rows } = await pool.query(`SELECT * FROM savings_products ${where} ORDER BY code`, params);
  return rows;
}

async function getSavingsProduct(db, productId) {
  const { rows } = await db.query('SELECT * FROM savings_products WHERE id = $1', [productId]);
  if (!rows[0]) throw new SavingsNotFoundError(`savings_product ${productId} not found`);
  return rows[0];
}

// --- Accounts ---------------------------------------------------------------

async function getBranchGlAccounts(db, branchId) {
  const { rows } = await db.query('SELECT * FROM branch_gl_accounts WHERE branch_id = $1', [branchId]);
  if (!rows[0]) throw new SavingsNotFoundError(`branch ${branchId} has no branch_gl_accounts row`);
  return rows[0];
}

async function getAccount(db, accountId) {
  const { rows } = await db.query('SELECT * FROM savings_accounts WHERE id = $1', [accountId]);
  if (!rows[0]) throw new SavingsNotFoundError(`savings_account ${accountId} not found`);
  return rows[0];
}

async function listAccounts(pool, { customerId, branchId, status } = {}) {
  const clauses = [];
  const params = [];
  const add = (col, val) => {
    if (val === undefined || val === null) return;
    params.push(val);
    clauses.push(`${col} = $${params.length}`);
  };
  add('customer_id', customerId);
  add('branch_id', branchId);
  add('status', status);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await pool.query(`SELECT * FROM savings_accounts ${where} ORDER BY id`, params);
  return rows;
}

/** Account numbers are `SAV-<branchCode>-<zero-padded sequence>` — readable and branch-identifiable. */
async function generateAccountNo(db, branchId, prefix = 'SAV') {
  const { rows } = await db.query('SELECT code FROM branches WHERE id = $1', [branchId]);
  if (!rows[0]) throw new SavingsValidationError(`branch ${branchId} not found`);
  const table = prefix === 'SAV' ? 'savings_accounts' : 'susu_accounts';
  const { rows: seqRows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM ${table} WHERE branch_id = $1`,
    [branchId]
  );
  return `${prefix}-${rows[0].code}-${String(seqRows[0].n + 1).padStart(5, '0')}`;
}

async function openAccount(pool, { customerId, productId, chargesConfig = null, createdBy }) {
  if (!customerId || !productId || !createdBy) {
    throw new SavingsValidationError('customerId, productId, and createdBy are required');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: customerRows } = await client.query('SELECT * FROM customers WHERE id = $1', [customerId]);
    const customer = customerRows[0];
    if (!customer) throw new SavingsValidationError(`customer ${customerId} not found`);
    if (customer.status !== 'active') {
      throw new SavingsConflictError(`customer ${customerId} is not active (status: ${customer.status})`);
    }
    if (customer.kyc_status !== 'verified') {
      throw new SavingsConflictError(`customer ${customerId} must be KYC-verified before opening an account`);
    }

    const product = await getSavingsProduct(client, productId);
    if (product.status !== 'active') throw new SavingsConflictError(`savings_product ${productId} is not active`);

    const accountNo = await generateAccountNo(client, customer.branch_id, 'SAV');
    const { rows } = await client.query(
      `INSERT INTO savings_accounts (account_no, customer_id, branch_id, product_id, charges_config, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [accountNo, customerId, customer.branch_id, productId, chargesConfig ? JSON.stringify(chargesConfig) : null, createdBy]
    );
    const account = rows[0];

    await auditLog.record(client, {
      userId: createdBy,
      branchId: account.branch_id,
      action: 'savings.account_opened',
      entityType: 'savings_account',
      entityId: account.id,
      afterState: account,
    });

    await client.query('COMMIT');
    return account;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function closeAccount(pool, { accountId, closedBy, reason = null }) {
  if (!closedBy) throw new SavingsValidationError('closedBy is required');
  const account = await getAccount(pool, accountId);
  if (account.status === 'closed') throw new SavingsConflictError(`savings_account ${accountId} is already closed`);
  if (Number(account.balance_pesewas) !== 0) {
    throw new SavingsConflictError(
      `savings_account ${accountId} cannot be closed with a non-zero balance (${account.balance_pesewas} pesewas) — withdraw or transfer the funds first`
    );
  }
  if (Number(account.overdraft_limit_pesewas) > 0) {
    throw new SavingsConflictError(
      `savings_account ${accountId} has an active overdraft facility (limit ${account.overdraft_limit_pesewas} pesewas) — close the overdraft loan first`
    );
  }

  const { rows } = await pool.query(
    "UPDATE savings_accounts SET status = 'closed', closed_at = now(), updated_at = now() WHERE id = $1 RETURNING *",
    [accountId]
  );
  await auditLog.record(pool, {
    userId: closedBy,
    branchId: account.branch_id,
    action: 'savings.account_closed',
    entityType: 'savings_account',
    entityId: accountId,
    beforeState: { status: account.status },
    afterState: { status: 'closed', reason },
  });
  return rows[0];
}

/** Resolves an account's effective charge config (product columns overlaid by any per-account override). */
async function getChargesConfigForAccount(db, account) {
  const product = await getSavingsProduct(db, account.product_id);
  return { product, chargesConfig: savingsMath.resolveChargesConfig(product, account.charges_config) };
}

// --- Core ledger movement ---------------------------------------------------

/**
 * The single funnel every balance movement goes through: locks the
 * account, applies the delta, writes an immutable savings_transactions
 * row, and (outside the transaction, since glPosting owns its own) posts
 * the matching GL entry and stamps the transaction with its id.
 *
 * `glLines` is a function of the branch's GL accounts so callers describe
 * their own posting without this helper knowing about every txn type.
 *
 * `minAllowedBalancePesewas` is the real floor the balance must not fall
 * below (defaults to 0 — no overdraft). Callers pass the account's actual
 * `-overdraft_limit_pesewas` here rather than bypassing the check
 * entirely — a previous version took a `skipBalanceCheck` boolean that,
 * for any allows_overdraft product, disabled the floor altogether. See
 * Decisions_Log.md.
 */
async function applyMovement(pool, params) {
  const {
    accountId,
    txnType,
    deltaPesewas,
    description = null,
    idempotencyKey = null,
    createdBy,
    entryDate = todayIso(),
    reference,
    buildGlLines,
    allowClosedAccount = false,
    minAllowedBalancePesewas = 0,
  } = params;

  if (!createdBy) throw new SavingsValidationError('createdBy is required');
  if (!Number.isInteger(deltaPesewas) || deltaPesewas === 0) {
    throw new SavingsValidationError('deltaPesewas must be a non-zero integer');
  }

  const client = await pool.connect();
  let context;
  try {
    await client.query('BEGIN');

    if (idempotencyKey) {
      const { rows: existing } = await client.query(
        'SELECT * FROM savings_transactions WHERE idempotency_key = $1',
        [idempotencyKey]
      );
      if (existing[0]) {
        await client.query('ROLLBACK');
        return { transaction: existing[0], idempotentReplay: true };
      }
    }

    const { rows: accountRows } = await client.query('SELECT * FROM savings_accounts WHERE id = $1 FOR UPDATE', [
      accountId,
    ]);
    const account = accountRows[0];
    if (!account) throw new SavingsNotFoundError(`savings_account ${accountId} not found`);
    if (!allowClosedAccount && account.status === 'closed') {
      throw new SavingsConflictError(`savings_account ${accountId} is closed`);
    }

    const balanceAfter = Number(account.balance_pesewas) + deltaPesewas;
    if (balanceAfter < Number(minAllowedBalancePesewas)) {
      throw new SavingsValidationError(
        `movement of ${deltaPesewas} would take savings_account ${accountId} below its allowed floor of ${minAllowedBalancePesewas} (balance ${account.balance_pesewas})`
      );
    }

    const { rows: txnRows } = await client.query(
      `INSERT INTO savings_transactions
         (account_id, txn_type, amount_pesewas, balance_after_pesewas, description, idempotency_key, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [accountId, txnType, deltaPesewas, balanceAfter, description, idempotencyKey, createdBy]
    );

    await client.query('UPDATE savings_accounts SET balance_pesewas = $1, updated_at = now() WHERE id = $2', [
      balanceAfter,
      accountId,
    ]);

    const glAccounts = await getBranchGlAccounts(client, account.branch_id);
    context = { account, transaction: txnRows[0], glAccounts, balanceAfter };

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const { account, transaction, glAccounts, balanceAfter } = context;
  const lines = buildGlLines({ glAccounts, branchId: account.branch_id });

  const journalEntry = await glPosting.postJournalEntry(pool, {
    branchId: account.branch_id,
    reference,
    description: description || `${txnType} on ${account.account_no}`,
    entryDate,
    sourceModule: 'savings',
    createdBy,
    lines,
  });

  await pool.query('UPDATE savings_transactions SET journal_entry_id = $1 WHERE id = $2', [
    journalEntry.id,
    transaction.id,
  ]);

  await auditLog.record(pool, {
    userId: createdBy,
    branchId: account.branch_id,
    action: `savings.${txnType}`,
    entityType: 'savings_account',
    entityId: accountId,
    afterState: { txnType, deltaPesewas, balanceAfter, journalEntryId: journalEntry.id },
  });

  return { transaction: { ...transaction, journal_entry_id: journalEntry.id }, balanceAfterPesewas: balanceAfter, journalEntry, idempotentReplay: false };
}

async function deposit(pool, { accountId, amountPesewas, depositedBy, description = null, idempotencyKey = null, entryDate }) {
  if (!Number.isInteger(amountPesewas) || amountPesewas <= 0) {
    throw new SavingsValidationError('amountPesewas must be a positive integer');
  }
  return applyMovement(pool, {
    accountId,
    txnType: 'deposit',
    deltaPesewas: amountPesewas,
    description,
    idempotencyKey,
    createdBy: depositedBy,
    entryDate,
    reference: `SAV-${accountId}-DEP-${Date.now()}`,
    buildGlLines: ({ glAccounts, branchId }) => [
      { accountId: glAccounts.cash_in_hand_account_id, debitPesewas: amountPesewas, branchId },
      { accountId: glAccounts.customer_deposits_account_id, creditPesewas: amountPesewas, branchId },
    ],
  });
}

// --- Withdrawals (threshold-gated) -------------------------------------------

/**
 * Resolves the effective withdrawal approval threshold for an account:
 * a Module 11 `approval_thresholds` row for 'savings.withdraw' (which
 * already prefers branch-specific over org-wide) beats the product/account
 * charge config. Business rule: "configurable per branch or per product".
 */
async function resolveWithdrawalThreshold(db, account, chargesConfig) {
  const thresholdRow = await approvalWorkflow.getApplicableThreshold(db, {
    actionType: 'savings.withdraw',
    branchId: account.branch_id,
  });
  return savingsMath.resolveWithdrawalThresholdPesewas(thresholdRow, chargesConfig);
}

/**
 * Requests a withdrawal. Below the threshold it pays out immediately;
 * at or above it, it creates a pending maker-checker approval and pays
 * out only once a different user approves (via the generic
 * POST /approvals/:id/decide, dispatched to payOutWithdrawalOnApproval).
 */
async function requestWithdrawal(pool, { accountId, amountPesewas, requestedBy, entryDate = todayIso() }) {
  if (!requestedBy) throw new SavingsValidationError('requestedBy is required');

  const account = await getAccount(pool, accountId);
  if (account.status === 'closed') throw new SavingsConflictError(`savings_account ${accountId} is closed`);

  const { chargesConfig } = await getChargesConfigForAccount(pool, account);
  const overdraftLimitPesewas = Number(account.overdraft_limit_pesewas) || 0;
  const assessment = savingsMath.assessWithdrawal({
    balancePesewas: account.balance_pesewas,
    amountPesewas,
    chargesConfig,
    overdraftLimitPesewas,
  });
  if (!assessment.ok) throw new SavingsValidationError(assessment.error);

  const thresholdPesewas = await resolveWithdrawalThreshold(pool, account, chargesConfig);
  const needsApproval = savingsMath.withdrawalNeedsApproval(amountPesewas, thresholdPesewas);

  if (!needsApproval) {
    const { rows } = await pool.query(
      `INSERT INTO withdrawal_requests (account_id, amount_pesewas, threshold_flag, status, requested_by)
       VALUES ($1, $2, false, 'pending', $3) RETURNING *`,
      [accountId, amountPesewas, requestedBy]
    );
    return payOutWithdrawal(pool, { withdrawalRequest: rows[0], paidBy: requestedBy, entryDate });
  }

  const approvalRequest = await approvalWorkflow.requestApproval(pool, {
    actionType: 'savings.withdraw',
    entityType: 'savings_account',
    entityId: accountId,
    branchId: account.branch_id,
    requestedBy,
    amountPesewas,
  });

  const { rows } = await pool.query(
    `INSERT INTO withdrawal_requests (account_id, amount_pesewas, threshold_flag, approval_request_id, status, requested_by)
     VALUES ($1, $2, true, $3, 'pending', $4) RETURNING *`,
    [accountId, amountPesewas, approvalRequest.id, requestedBy]
  );

  return { withdrawalRequest: rows[0], approvalRequest, paidOut: false, thresholdPesewas };
}

/** Performs the actual payout movement (fee included) for a withdrawal request. */
async function payOutWithdrawal(pool, { withdrawalRequest, paidBy, entryDate = todayIso() }) {
  const account = await getAccount(pool, withdrawalRequest.account_id);
  const { chargesConfig } = await getChargesConfigForAccount(pool, account);
  const amountPesewas = Number(withdrawalRequest.amount_pesewas);
  const overdraftLimitPesewas = Number(account.overdraft_limit_pesewas) || 0;
  const minAllowedBalancePesewas = -overdraftLimitPesewas;

  const assessment = savingsMath.assessWithdrawal({
    balancePesewas: account.balance_pesewas,
    amountPesewas,
    chargesConfig,
    overdraftLimitPesewas,
  });
  if (!assessment.ok) throw new SavingsValidationError(assessment.error);

  const result = await applyMovement(pool, {
    accountId: account.id,
    txnType: 'withdrawal',
    deltaPesewas: -amountPesewas,
    description: `Withdrawal from ${account.account_no}`,
    createdBy: paidBy,
    entryDate,
    reference: `SAV-${account.id}-WDL-${withdrawalRequest.id}`,
    minAllowedBalancePesewas,
    buildGlLines: ({ glAccounts, branchId }) => [
      { accountId: glAccounts.customer_deposits_account_id, debitPesewas: amountPesewas, branchId },
      { accountId: glAccounts.cash_in_hand_account_id, creditPesewas: amountPesewas, branchId },
    ],
  });

  let feeTransaction = null;
  if (assessment.feePesewas > 0) {
    feeTransaction = await applyMovement(pool, {
      accountId: account.id,
      txnType: 'withdrawal_fee',
      deltaPesewas: -assessment.feePesewas,
      description: `Withdrawal fee on ${account.account_no}`,
      createdBy: paidBy,
      entryDate,
      reference: `SAV-${account.id}-WFEE-${withdrawalRequest.id}`,
      minAllowedBalancePesewas,
      buildGlLines: ({ glAccounts, branchId }) => [
        { accountId: glAccounts.customer_deposits_account_id, debitPesewas: assessment.feePesewas, branchId },
        { accountId: glAccounts.savings_fee_income_account_id, creditPesewas: assessment.feePesewas, branchId },
      ],
    });
  }

  const { rows } = await pool.query(
    `UPDATE withdrawal_requests SET status = 'paid', transaction_id = $1, updated_at = now() WHERE id = $2 RETURNING *`,
    [result.transaction.id, withdrawalRequest.id]
  );

  return {
    withdrawalRequest: rows[0],
    paidOut: true,
    transaction: result.transaction,
    feePesewas: assessment.feePesewas,
    feeTransaction: feeTransaction ? feeTransaction.transaction : null,
    balanceAfterPesewas: feeTransaction ? feeTransaction.balanceAfterPesewas : result.balanceAfterPesewas,
  };
}

/**
 * Registered as the 'savings.withdraw' execution handler. Note it pays out
 * via the pool, NOT the approval's transaction client: applyMovement and
 * glPosting each own their own transactions. The trade-off is documented
 * in Decisions_Log.md — a payout failure leaves the approval approved and
 * the withdrawal_request 'pending', which is visible and retryable rather
 * than silently lost.
 */
async function payOutWithdrawalOnApproval(approvalRequest, db) {
  const { rows } = await db.query('SELECT * FROM withdrawal_requests WHERE approval_request_id = $1', [
    approvalRequest.id,
  ]);
  const withdrawalRequest = rows[0];
  if (!withdrawalRequest) {
    throw new SavingsNotFoundError(`no withdrawal_request for approval_request ${approvalRequest.id}`);
  }
  // Mark the approval outcome inside the caller's transaction; the money
  // movement happens after it commits, via the pending request.
  await auditLog.record(db, {
    userId: approvalRequest.decided_by,
    branchId: approvalRequest.branch_id,
    action: 'savings.withdrawal_approved',
    entityType: 'withdrawal_request',
    entityId: withdrawalRequest.id,
    afterState: { approvalRequestId: approvalRequest.id },
  });
}

/** Pays out an approved-but-unpaid withdrawal request. Idempotent by status. */
async function settleApprovedWithdrawal(pool, { withdrawalRequestId, paidBy, entryDate }) {
  const { rows } = await pool.query(
    `SELECT wr.*, ar.status AS approval_status FROM withdrawal_requests wr
       LEFT JOIN approval_requests ar ON ar.id = wr.approval_request_id
      WHERE wr.id = $1`,
    [withdrawalRequestId]
  );
  const request = rows[0];
  if (!request) throw new SavingsNotFoundError(`withdrawal_request ${withdrawalRequestId} not found`);
  if (request.status === 'paid') throw new SavingsConflictError(`withdrawal_request ${withdrawalRequestId} is already paid`);
  if (request.threshold_flag && request.approval_status !== 'approved') {
    throw new SavingsConflictError(
      `withdrawal_request ${withdrawalRequestId} is not approved (approval status: ${request.approval_status})`
    );
  }
  return payOutWithdrawal(pool, { withdrawalRequest: request, paidBy, entryDate });
}

// --- Charges ------------------------------------------------------------------

/**
 * Applies periodic charges to an account: the maintenance fee, plus the
 * minimum-balance charge when the balance has fallen below the minimum.
 * Called per-account by staff or (later) in bulk by Module 12's scheduler.
 */
async function applyCharges(pool, { accountId, appliedBy, entryDate = todayIso(), chargeTypes = ['maintenance_fee', 'min_balance_charge'] }) {
  if (!appliedBy) throw new SavingsValidationError('appliedBy is required');
  const account = await getAccount(pool, accountId);
  if (account.status === 'closed') throw new SavingsConflictError(`savings_account ${accountId} is closed`);
  const { chargesConfig } = await getChargesConfigForAccount(pool, account);

  const applied = [];
  let balance = Number(account.balance_pesewas);

  for (const chargeType of chargeTypes) {
    const amount =
      chargeType === 'maintenance_fee'
        ? savingsMath.computeMaintenanceFeePesewas(balance, chargesConfig)
        : savingsMath.computeMinBalanceChargePesewas(balance, chargesConfig);
    if (amount <= 0) continue;

    const result = await applyMovement(pool, {
      accountId,
      txnType: chargeType,
      deltaPesewas: -amount,
      description: `${chargeType} on ${account.account_no}`,
      createdBy: appliedBy,
      entryDate,
      reference: `SAV-${accountId}-${chargeType.toUpperCase()}-${Date.now()}`,
      buildGlLines: ({ glAccounts, branchId }) => [
        { accountId: glAccounts.customer_deposits_account_id, debitPesewas: amount, branchId },
        { accountId: glAccounts.savings_fee_income_account_id, creditPesewas: amount, branchId },
      ],
    });
    balance = result.balanceAfterPesewas;
    applied.push({ chargeType, amountPesewas: amount, balanceAfterPesewas: balance });
  }

  return { accountId, applied, balancePesewas: balance };
}

// --- Statement & reconciliation -------------------------------------------------

async function getStatement(pool, { accountId, from = null, to = null, limit = 100 }) {
  const account = await getAccount(pool, accountId);
  const params = [accountId];
  let where = 'account_id = $1';
  if (from) {
    params.push(from);
    where += ` AND created_at >= $${params.length}`;
  }
  if (to) {
    params.push(to);
    where += ` AND created_at <= $${params.length}`;
  }
  params.push(Math.min(Number(limit) || 100, 500));
  const { rows } = await pool.query(
    `SELECT * FROM savings_transactions WHERE ${where} ORDER BY id DESC LIMIT $${params.length}`,
    params
  );
  return { account, transactions: rows };
}

/**
 * Proves the stored subledger balance still equals the sum of its
 * immutable transaction history. This is the per-account half of Module
 * 7's "GL-to-customer-account reconciliation report" — see
 * Decisions_Log.md on why a stored balance is safe here.
 */
async function reconcileAccount(pool, { accountId }) {
  const account = await getAccount(pool, accountId);
  const { rows } = await pool.query(
    'SELECT COALESCE(SUM(amount_pesewas), 0)::bigint AS total FROM savings_transactions WHERE account_id = $1',
    [accountId]
  );
  const ledgerSum = Number(rows[0].total);
  const storedBalance = Number(account.balance_pesewas);
  return { accountId: Number(accountId), storedBalancePesewas: storedBalance, ledgerSumPesewas: ledgerSum, reconciled: ledgerSum === storedBalance };
}

/** Branch-level: do the savings subledger balances add up to the GL control account? */
async function reconcileBranchDeposits(pool, { branchId }) {
  const glAccounts = await getBranchGlAccounts(pool, branchId);
  const { rows } = await pool.query(
    "SELECT COALESCE(SUM(balance_pesewas), 0)::bigint AS total FROM savings_accounts WHERE branch_id = $1 AND status <> 'closed'",
    [branchId]
  );
  const subledgerTotal = Number(rows[0].total);
  const glBalance = await glPosting.getAccountBalance(pool, {
    accountId: glAccounts.customer_deposits_account_id,
    branchId,
  });
  return {
    branchId: Number(branchId),
    subledgerTotalPesewas: subledgerTotal,
    glControlBalancePesewas: glBalance,
    reconciled: subledgerTotal === glBalance,
    variancePesewas: subledgerTotal - glBalance,
  };
}

function registerSavingsExecutionHandlers() {
  approvalWorkflow.registerExecutionHandler('savings.withdraw', payOutWithdrawalOnApproval);
}

module.exports = {
  createSavingsProduct,
  listSavingsProducts,
  getSavingsProduct,
  openAccount,
  closeAccount,
  getAccount,
  listAccounts,
  deposit,
  requestWithdrawal,
  settleApprovedWithdrawal,
  payOutWithdrawalOnApproval,
  applyCharges,
  getChargesConfigForAccount,
  applyMovement,
  getStatement,
  reconcileAccount,
  reconcileBranchDeposits,
  getBranchGlAccounts,
  generateAccountNo,
  resolveWithdrawalThreshold,
  registerSavingsExecutionHandlers,
  SavingsValidationError,
  SavingsNotFoundError,
  SavingsConflictError,
};
