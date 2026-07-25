'use strict';

const auditLog = require('../../shared/auditLog');
const approvalWorkflow = require('../../shared/approvalWorkflow');
const glPosting = require('../../shared/glPosting');

/**
 * Module 1: Branch Creation & Management. Uses the Module 11/7 shared
 * services (auditLog, approvalWorkflow, glPosting) exactly as documented in
 * Decisions_Log.md rather than reimplementing audit/approval/posting logic.
 */

class BranchValidationError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 400;
  }
}
class BranchNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 404;
  }
}
class BranchImmutableCodeError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 409;
  }
}
class InvalidStatusTransitionError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 409;
  }
}
class BranchReconciliationError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 409;
  }
}

// --- Pure helpers (no db) -------------------------------------------------

const BRANCH_CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{1,9}$/;

/**
 * Branch codes are capped at 10 chars so the auto-generated GL sub-account
 * code "<control_code>.<branch_code>" fits gl_accounts.code (VARCHAR(20)) —
 * see migration 010_branch_hierarchy.sql.
 */
function validateBranchCode(rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!BRANCH_CODE_PATTERN.test(code)) {
    throw new BranchValidationError(
      'branch code must be 2-10 characters: uppercase letters, digits, or hyphens, starting with a letter or digit'
    );
  }
  return code;
}

const VALID_STATUS_TRANSITIONS = {
  active: ['suspended', 'under_review'],
  suspended: ['active', 'under_review', 'closed'],
  under_review: ['active', 'suspended', 'closed'],
  closed: [],
};

function isValidStatusTransition(fromStatus, toStatus) {
  return Boolean(VALID_STATUS_TRANSITIONS[fromStatus] && VALID_STATUS_TRANSITIONS[fromStatus].includes(toStatus));
}

function toDate(value) {
  return value instanceof Date ? value : new Date(value);
}

/** Cross-branch access grants "expire automatically" — checked lazily here rather than by a background job, since Module 12 (scheduler) doesn't exist yet. See Decisions_Log.md Open Questions. */
function isGrantActive(grant, asOf = new Date()) {
  if (grant.revoked_at) return false;
  const asOfDate = toDate(asOf);
  return toDate(grant.start_date) <= asOfDate && asOfDate <= toDate(grant.end_date);
}

function glSubAccountCode(controlCode, branchCode) {
  return `${controlCode}.${branchCode}`;
}

// --- Control account lookup -----------------------------------------------

const CONTROL_ACCOUNT_CODES = {
  cashInHand: '1000',
  vault: '1010',
  transit: '1020',
  cashWithAgents: '1030', // added in Module 4
  loansReceivable: '1100', // added in Module 3
  customerDeposits: '2000', // added in Module 4
  susuDeposits: '2010', // added in Module 4
  agentCommissionPayable: '2020', // added in Module 4
  income: '4000',
  loanInterestIncome: '4010', // added in Module 3
  loanFeeIncome: '4020', // added in Module 3
  savingsFeeIncome: '4030', // added in Module 4
  expense: '5000',
  loanLossExpense: '5100', // added in Module 3
  agentCommissionExpense: '5200', // added in Module 4
};

async function getControlAccounts(db) {
  const codes = Object.values(CONTROL_ACCOUNT_CODES);
  const { rows } = await db.query('SELECT * FROM gl_accounts WHERE code = ANY($1)', [codes]);
  const byCode = Object.fromEntries(rows.map((r) => [r.code, r]));
  const missing = codes.filter((c) => !byCode[c]);
  if (missing.length > 0) {
    throw new Error(`GL control accounts missing (run migrations): ${missing.join(', ')}`);
  }
  return Object.fromEntries(Object.entries(CONTROL_ACCOUNT_CODES).map(([key, code]) => [key, byCode[code]]));
}

async function getBranchGlAccounts(db, branchId) {
  const { rows } = await db.query('SELECT * FROM branch_gl_accounts WHERE branch_id = $1', [branchId]);
  if (!rows[0]) {
    throw new BranchNotFoundError(`branch ${branchId} has no branch_gl_accounts row`);
  }
  return rows[0];
}

// --- Branch CRUD ------------------------------------------------------------

/**
 * Create a branch and auto-generate its GL sub-accounts (cash-in-hand,
 * vault, income, expense, plus loans-receivable/loan-interest-income/
 * loan-fee-income/loan-loss-expense added in Module 3), each bound to
 * branch_id and parented to the matching org-wide control account.
 * Everything commits in one transaction.
 */
async function createBranch(pool, params) {
  const {
    code: rawCode,
    name,
    regionId = null,
    clusterId = null,
    address = null,
    gpsLat = null,
    gpsLng = null,
    openingDate = null,
    operatingHours = null,
    licenceRef = null,
    openingFloatPesewas = 0,
    dailyCashLimitPesewas = 0,
    createdBy,
  } = params;

  if (!name || !createdBy) {
    throw new BranchValidationError('name and createdBy are required');
  }
  const code = validateBranchCode(rawCode);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const controls = await getControlAccounts(client);

    const { rows: branchRows } = await client.query(
      `INSERT INTO branches
         (code, name, region_id, cluster_id, address, gps_lat, gps_lng, opening_date, operating_hours, licence_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [code, name, regionId, clusterId, address, gpsLat, gpsLng, openingDate, operatingHours, licenceRef]
    );
    const branch = branchRows[0];

    async function createSubAccount(control) {
      const { rows } = await client.query(
        `INSERT INTO gl_accounts (code, name, account_type, branch_id, parent_account_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [glSubAccountCode(control.code, code), `${control.name} - ${name}`, control.account_type, branch.id, control.id]
      );
      return rows[0];
    }

    const cashInHandAccount = await createSubAccount(controls.cashInHand);
    const vaultAccount = await createSubAccount(controls.vault);
    const incomeAccount = await createSubAccount(controls.income);
    const expenseAccount = await createSubAccount(controls.expense);
    const loansReceivableAccount = await createSubAccount(controls.loansReceivable);
    const loanInterestIncomeAccount = await createSubAccount(controls.loanInterestIncome);
    const loanFeeIncomeAccount = await createSubAccount(controls.loanFeeIncome);
    const loanLossExpenseAccount = await createSubAccount(controls.loanLossExpense);
    const cashWithAgentsAccount = await createSubAccount(controls.cashWithAgents);
    const customerDepositsAccount = await createSubAccount(controls.customerDeposits);
    const susuDepositsAccount = await createSubAccount(controls.susuDeposits);
    const agentCommissionPayableAccount = await createSubAccount(controls.agentCommissionPayable);
    const savingsFeeIncomeAccount = await createSubAccount(controls.savingsFeeIncome);
    const agentCommissionExpenseAccount = await createSubAccount(controls.agentCommissionExpense);

    await client.query(
      `INSERT INTO branch_gl_accounts
         (branch_id, cash_in_hand_account_id, vault_account_id, income_account_id, expense_account_id,
          loans_receivable_account_id, loan_interest_income_account_id, loan_fee_income_account_id, loan_loss_expense_account_id,
          cash_with_agents_account_id, customer_deposits_account_id, susu_deposits_account_id,
          agent_commission_payable_account_id, savings_fee_income_account_id, agent_commission_expense_account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        branch.id,
        cashInHandAccount.id,
        vaultAccount.id,
        incomeAccount.id,
        expenseAccount.id,
        loansReceivableAccount.id,
        loanInterestIncomeAccount.id,
        loanFeeIncomeAccount.id,
        loanLossExpenseAccount.id,
        cashWithAgentsAccount.id,
        customerDepositsAccount.id,
        susuDepositsAccount.id,
        agentCommissionPayableAccount.id,
        savingsFeeIncomeAccount.id,
        agentCommissionExpenseAccount.id,
      ]
    );

    await client.query(
      `INSERT INTO branch_vault_configs (branch_id, opening_float_pesewas, daily_cash_limit_pesewas)
       VALUES ($1, $2, $3)`,
      [branch.id, openingFloatPesewas, dailyCashLimitPesewas]
    );

    const result = {
      ...branch,
      glAccounts: {
        cashInHand: cashInHandAccount,
        vault: vaultAccount,
        income: incomeAccount,
        expense: expenseAccount,
        loansReceivable: loansReceivableAccount,
        loanInterestIncome: loanInterestIncomeAccount,
        loanFeeIncome: loanFeeIncomeAccount,
        loanLossExpense: loanLossExpenseAccount,
        cashWithAgents: cashWithAgentsAccount,
        customerDeposits: customerDepositsAccount,
        susuDeposits: susuDepositsAccount,
        agentCommissionPayable: agentCommissionPayableAccount,
        savingsFeeIncome: savingsFeeIncomeAccount,
        agentCommissionExpense: agentCommissionExpenseAccount,
      },
    };

    await auditLog.record(client, {
      userId: createdBy,
      branchId: branch.id,
      action: 'branch.created',
      entityType: 'branch',
      entityId: branch.id,
      afterState: result,
    });

    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getBranch(pool, branchId) {
  const { rows } = await pool.query('SELECT * FROM branches WHERE id = $1', [branchId]);
  if (!rows[0]) throw new BranchNotFoundError(`branch ${branchId} not found`);
  return rows[0];
}

async function listBranches(pool, { regionId, clusterId, status } = {}) {
  const clauses = [];
  const params = [];
  if (regionId) {
    params.push(regionId);
    clauses.push(`region_id = $${params.length}`);
  }
  if (clusterId) {
    params.push(clusterId);
    clauses.push(`cluster_id = $${params.length}`);
  }
  if (status) {
    params.push(status);
    clauses.push(`status = $${params.length}`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await pool.query(`SELECT * FROM branches ${where} ORDER BY code`, params);
  return rows;
}

const MUTABLE_BRANCH_FIELDS = {
  name: 'name',
  regionId: 'region_id',
  clusterId: 'cluster_id',
  address: 'address',
  gpsLat: 'gps_lat',
  gpsLng: 'gps_lng',
  openingDate: 'opening_date',
  operatingHours: 'operating_hours',
  licenceRef: 'licence_ref',
};

/**
 * Update branch details. `code` may only be changed while the branch has no
 * GL activity yet (business rule: "branch code must be immutable once
 * transactions exist against it").
 */
async function updateBranch(pool, { branchId, updatedBy, fields }) {
  if (!updatedBy) throw new BranchValidationError('updatedBy is required');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: beforeRows } = await client.query('SELECT * FROM branches WHERE id = $1 FOR UPDATE', [branchId]);
    const before = beforeRows[0];
    if (!before) throw new BranchNotFoundError(`branch ${branchId} not found`);

    const setClauses = [];
    const params = [];

    if (fields.code !== undefined) {
      const newCode = validateBranchCode(fields.code);
      if (newCode !== before.code) {
        const { rows: txnRows } = await client.query(
          `SELECT 1 FROM gl_journal_lines WHERE branch_id = $1 LIMIT 1`,
          [branchId]
        );
        if (txnRows.length > 0) {
          throw new BranchImmutableCodeError(`branch ${branchId} has GL activity; its code can no longer be changed`);
        }
        params.push(newCode);
        setClauses.push(`code = $${params.length}`);
      }
    }

    for (const [key, column] of Object.entries(MUTABLE_BRANCH_FIELDS)) {
      if (fields[key] !== undefined) {
        params.push(fields[key]);
        setClauses.push(`${column} = $${params.length}`);
      }
    }

    if (setClauses.length === 0) {
      await client.query('ROLLBACK');
      return before;
    }

    params.push(branchId);
    const { rows } = await client.query(
      `UPDATE branches SET ${setClauses.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`,
      params
    );
    const after = rows[0];

    await auditLog.record(client, {
      userId: updatedBy,
      branchId,
      action: 'branch.updated',
      entityType: 'branch',
      entityId: branchId,
      beforeState: before,
      afterState: after,
    });

    await client.query('COMMIT');
    return after;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// --- Status lifecycle / closure (maker-checker + reconciliation) ----------

async function assertZeroBalances(db, branchId) {
  const glAccounts = await getBranchGlAccounts(db, branchId);
  const cashBalance = await glPosting.getAccountBalance(db, { accountId: glAccounts.cash_in_hand_account_id, branchId });
  const vaultBalance = await glPosting.getAccountBalance(db, { accountId: glAccounts.vault_account_id, branchId });
  if (cashBalance !== 0 || vaultBalance !== 0) {
    throw new BranchReconciliationError(
      `branch ${branchId} cannot close: cash-in-hand=${cashBalance} pesewas, vault=${vaultBalance} pesewas (both must be zero)`
    );
  }
}

/**
 * Transition a branch's status. Closing requires the GL-reconciliation
 * check to pass AND maker-checker approval (via approvalWorkflow) — this
 * function only *requests* closure; the actual status change happens in
 * `closeBranchOnApproval` once a different user approves it. Every other
 * transition applies immediately (still permission-gated and audited).
 */
async function changeBranchStatus(pool, { branchId, toStatus, requestedBy, reason = null }) {
  if (!requestedBy) throw new BranchValidationError('requestedBy is required');

  const branch = await getBranch(pool, branchId);
  if (!isValidStatusTransition(branch.status, toStatus)) {
    throw new InvalidStatusTransitionError(`cannot transition branch ${branchId} from '${branch.status}' to '${toStatus}'`);
  }

  if (toStatus === 'closed') {
    // Fail fast with a clear error rather than silently queuing an approval
    // that can never succeed — per the "must be blocked with a clear error"
    // business rule.
    await assertZeroBalances(pool, branchId);

    return approvalWorkflow.requestApproval(pool, {
      actionType: 'branch.close',
      entityType: 'branch',
      entityId: branchId,
      branchId,
      requestedBy,
      payload: { reason },
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE branches SET status = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [toStatus, branchId]
    );
    const after = rows[0];
    await auditLog.record(client, {
      userId: requestedBy,
      branchId,
      action: 'branch.status_changed',
      entityType: 'branch',
      entityId: branchId,
      beforeState: branch,
      afterState: after,
    });
    await client.query('COMMIT');
    return after;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Registered with approvalWorkflow as the execute handler for
 * 'branch.close' (see registerBranchExecutionHandlers below), so approving
 * a branch-closure request via the generic POST /approvals/:id/decide
 * endpoint actually applies the closure. Re-checks reconciliation at
 * decide-time (balances could have moved since the request was filed) —
 * if it fails now, this throws and the whole decide() transaction rolls
 * back, leaving the approval request 'pending' so it can be retried later.
 */
async function closeBranchOnApproval(approvalRequest, db) {
  const branchId = Number(approvalRequest.entity_id);
  await assertZeroBalances(db, branchId);

  const { rows: beforeRows } = await db.query('SELECT * FROM branches WHERE id = $1 FOR UPDATE', [branchId]);
  const before = beforeRows[0];
  if (!before) throw new BranchNotFoundError(`branch ${branchId} not found`);

  const { rows } = await db.query(
    `UPDATE branches SET status = 'closed', updated_at = now() WHERE id = $1 RETURNING *`,
    [branchId]
  );
  const after = rows[0];

  await auditLog.record(db, {
    userId: approvalRequest.decided_by,
    branchId,
    action: 'branch.status_changed',
    entityType: 'branch',
    entityId: branchId,
    beforeState: before,
    afterState: after,
  });
}

/** Call once at app startup so decide() can dispatch branch closures. */
function registerBranchExecutionHandlers() {
  approvalWorkflow.registerExecutionHandler('branch.close', closeBranchOnApproval);
}

// --- Regions / clusters ------------------------------------------------------

async function createRegion(pool, { name }) {
  if (!name) throw new BranchValidationError('name is required');
  const { rows } = await pool.query('INSERT INTO branch_regions (name) VALUES ($1) RETURNING *', [name]);
  return rows[0];
}

async function listRegions(pool) {
  const { rows } = await pool.query('SELECT * FROM branch_regions ORDER BY name');
  return rows;
}

async function createCluster(pool, { name, regionId }) {
  if (!name || !regionId) throw new BranchValidationError('name and regionId are required');
  const { rows } = await pool.query(
    'INSERT INTO branch_clusters (name, region_id) VALUES ($1, $2) RETURNING *',
    [name, regionId]
  );
  return rows[0];
}

async function listClusters(pool, { regionId } = {}) {
  const params = [];
  let where = '';
  if (regionId) {
    params.push(regionId);
    where = 'WHERE region_id = $1';
  }
  const { rows } = await pool.query(`SELECT * FROM branch_clusters ${where} ORDER BY name`, params);
  return rows;
}

// --- Staff assignment --------------------------------------------------------

async function assignStaff(pool, { branchId, userId, assignedBy }) {
  if (!branchId || !userId || !assignedBy) {
    throw new BranchValidationError('branchId, userId, and assignedBy are required');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: userRows } = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const beforeUser = userRows[0];
    if (!beforeUser) throw new BranchValidationError(`user ${userId} not found`);

    await client.query(
      `UPDATE branch_staff_assignments SET end_date = current_date WHERE user_id = $1 AND end_date IS NULL`,
      [userId]
    );

    const { rows: assignmentRows } = await client.query(
      `INSERT INTO branch_staff_assignments (user_id, branch_id, assigned_by)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [userId, branchId, assignedBy]
    );

    const { rows: afterUserRows } = await client.query(
      `UPDATE users SET home_branch_id = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [branchId, userId]
    );

    await auditLog.record(client, {
      userId: assignedBy,
      branchId,
      action: 'branch.staff_assigned',
      entityType: 'user',
      entityId: userId,
      beforeState: { homeBranchId: beforeUser.home_branch_id },
      afterState: { homeBranchId: branchId, assignment: assignmentRows[0] },
    });

    await client.query('COMMIT');
    return { assignment: assignmentRows[0], user: afterUserRows[0] };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function listStaffAssignments(pool, { branchId, userId } = {}) {
  const clauses = [];
  const params = [];
  if (branchId) {
    params.push(branchId);
    clauses.push(`branch_id = $${params.length}`);
  }
  if (userId) {
    params.push(userId);
    clauses.push(`user_id = $${params.length}`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT * FROM branch_staff_assignments ${where} ORDER BY start_date DESC, id DESC`,
    params
  );
  return rows;
}

// --- Cross-branch access grants ----------------------------------------------

async function grantCrossBranchAccess(pool, { userId, branchId, startDate, endDate, grantedBy }) {
  if (!userId || !branchId || !startDate || !endDate || !grantedBy) {
    throw new BranchValidationError('userId, branchId, startDate, endDate, and grantedBy are required');
  }
  const { rows } = await pool.query(
    `INSERT INTO cross_branch_access_grants (user_id, branch_id, start_date, end_date, granted_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [userId, branchId, startDate, endDate, grantedBy]
  );
  const grant = rows[0];
  await auditLog.record(pool, {
    userId: grantedBy,
    branchId,
    action: 'branch.cross_branch_grant_created',
    entityType: 'cross_branch_access_grant',
    entityId: grant.id,
    afterState: grant,
  });
  return grant;
}

async function revokeCrossBranchAccess(pool, { grantId, revokedBy }) {
  if (!revokedBy) throw new BranchValidationError('revokedBy is required');
  const { rows } = await pool.query(
    `UPDATE cross_branch_access_grants SET revoked_at = now(), revoked_by = $1
     WHERE id = $2 AND revoked_at IS NULL
     RETURNING *`,
    [revokedBy, grantId]
  );
  const grant = rows[0];
  if (!grant) throw new BranchNotFoundError(`active cross_branch_access_grant ${grantId} not found`);
  await auditLog.record(pool, {
    userId: revokedBy,
    branchId: grant.branch_id,
    action: 'branch.cross_branch_grant_revoked',
    entityType: 'cross_branch_access_grant',
    entityId: grant.id,
    afterState: grant,
  });
  return grant;
}

async function listActiveCrossBranchGrants(pool, { userId }) {
  const { rows } = await pool.query(
    'SELECT * FROM cross_branch_access_grants WHERE user_id = $1 AND revoked_at IS NULL',
    [userId]
  );
  return rows.filter((grant) => isGrantActive(grant));
}

// --- Cash-in-transit branch transfers -----------------------------------------

async function initiateTransfer(pool, { sourceBranchId, destinationBranchId, amountPesewas, reason = null, initiatedBy }) {
  if (!sourceBranchId || !destinationBranchId || !amountPesewas || !initiatedBy) {
    throw new BranchValidationError('sourceBranchId, destinationBranchId, amountPesewas, and initiatedBy are required');
  }
  if (sourceBranchId === destinationBranchId) {
    throw new BranchValidationError('sourceBranchId and destinationBranchId must differ');
  }
  if (!Number.isInteger(amountPesewas) || amountPesewas <= 0) {
    throw new BranchValidationError('amountPesewas must be a positive integer');
  }

  const sourceGlAccounts = await getBranchGlAccounts(pool, sourceBranchId);
  const controls = await getControlAccounts(pool);

  const sourceCashBalance = await glPosting.getAccountBalance(pool, {
    accountId: sourceGlAccounts.cash_in_hand_account_id,
    branchId: sourceBranchId,
  });
  if (sourceCashBalance < amountPesewas) {
    throw new BranchValidationError(
      `source branch ${sourceBranchId} has insufficient cash-in-hand (${sourceCashBalance} < ${amountPesewas} pesewas)`
    );
  }

  const { rows: transferRows } = await pool.query(
    `INSERT INTO branch_transfers (source_branch_id, destination_branch_id, amount_pesewas, reason, initiated_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [sourceBranchId, destinationBranchId, amountPesewas, reason, initiatedBy]
  );
  const transfer = transferRows[0];

  const entryDate = new Date().toISOString().slice(0, 10);
  const journalEntry = await glPosting.postJournalEntry(pool, {
    branchId: sourceBranchId,
    reference: `BT-${transfer.id}-OUT`,
    description: `Cash-in-transit to branch ${destinationBranchId}`,
    entryDate,
    sourceModule: 'branch_transfer',
    createdBy: initiatedBy,
    lines: [
      { accountId: controls.transit.id, debitPesewas: amountPesewas },
      { accountId: sourceGlAccounts.cash_in_hand_account_id, creditPesewas: amountPesewas, branchId: sourceBranchId },
    ],
  });

  const { rows: updatedRows } = await pool.query(
    `UPDATE branch_transfers SET status = 'in_transit', out_journal_entry_id = $1, updated_at = now() WHERE id = $2 RETURNING *`,
    [journalEntry.id, transfer.id]
  );

  await auditLog.record(pool, {
    userId: initiatedBy,
    branchId: sourceBranchId,
    action: 'branch_transfer.initiated',
    entityType: 'branch_transfer',
    entityId: transfer.id,
    afterState: updatedRows[0],
  });

  return updatedRows[0];
}

async function getTransfer(pool, transferId) {
  const { rows } = await pool.query('SELECT * FROM branch_transfers WHERE id = $1', [transferId]);
  if (!rows[0]) throw new BranchNotFoundError(`branch_transfer ${transferId} not found`);
  return rows[0];
}

async function confirmTransfer(pool, { transferId, confirmedBy }) {
  if (!confirmedBy) throw new BranchValidationError('confirmedBy is required');
  const transfer = await getTransfer(pool, transferId);
  if (transfer.status !== 'in_transit') {
    throw new BranchValidationError(`branch_transfer ${transferId} is not in_transit (status: ${transfer.status})`);
  }

  const destinationGlAccounts = await getBranchGlAccounts(pool, transfer.destination_branch_id);
  const controls = await getControlAccounts(pool);
  const entryDate = new Date().toISOString().slice(0, 10);

  const journalEntry = await glPosting.postJournalEntry(pool, {
    branchId: transfer.destination_branch_id,
    reference: `BT-${transfer.id}-IN`,
    description: `Cash-in-transit received from branch ${transfer.source_branch_id}`,
    entryDate,
    sourceModule: 'branch_transfer',
    createdBy: confirmedBy,
    lines: [
      {
        accountId: destinationGlAccounts.cash_in_hand_account_id,
        debitPesewas: transfer.amount_pesewas,
        branchId: transfer.destination_branch_id,
      },
      { accountId: controls.transit.id, creditPesewas: transfer.amount_pesewas },
    ],
  });

  const { rows } = await pool.query(
    `UPDATE branch_transfers SET status = 'completed', confirmed_by = $1, in_journal_entry_id = $2, updated_at = now() WHERE id = $3 RETURNING *`,
    [confirmedBy, journalEntry.id, transfer.id]
  );

  await auditLog.record(pool, {
    userId: confirmedBy,
    branchId: transfer.destination_branch_id,
    action: 'branch_transfer.confirmed',
    entityType: 'branch_transfer',
    entityId: transfer.id,
    afterState: rows[0],
  });

  return rows[0];
}

async function cancelTransfer(pool, { transferId, cancelledBy, reason = null }) {
  if (!cancelledBy) throw new BranchValidationError('cancelledBy is required');
  const transfer = await getTransfer(pool, transferId);
  if (transfer.status !== 'in_transit') {
    throw new BranchValidationError(`branch_transfer ${transferId} cannot be cancelled (status: ${transfer.status})`);
  }

  const sourceGlAccounts = await getBranchGlAccounts(pool, transfer.source_branch_id);
  const controls = await getControlAccounts(pool);
  const entryDate = new Date().toISOString().slice(0, 10);

  const journalEntry = await glPosting.postJournalEntry(pool, {
    branchId: transfer.source_branch_id,
    reference: `BT-${transfer.id}-CANCEL`,
    description: reason || `Cancelled cash-in-transit to branch ${transfer.destination_branch_id}`,
    entryDate,
    sourceModule: 'branch_transfer',
    createdBy: cancelledBy,
    lines: [
      { accountId: sourceGlAccounts.cash_in_hand_account_id, debitPesewas: transfer.amount_pesewas, branchId: transfer.source_branch_id },
      { accountId: controls.transit.id, creditPesewas: transfer.amount_pesewas },
    ],
  });

  const { rows } = await pool.query(
    `UPDATE branch_transfers SET status = 'cancelled', cancelled_by = $1, reversal_journal_entry_id = $2, updated_at = now() WHERE id = $3 RETURNING *`,
    [cancelledBy, journalEntry.id, transfer.id]
  );

  await auditLog.record(pool, {
    userId: cancelledBy,
    branchId: transfer.source_branch_id,
    action: 'branch_transfer.cancelled',
    entityType: 'branch_transfer',
    entityId: transfer.id,
    afterState: rows[0],
  });

  return rows[0];
}

// --- Performance dashboard ------------------------------------------------

/**
 * Only surfaces metrics genuinely computable from what's built so far
 * (branches, GL, staff assignments). Loan/deposit-derived metrics
 * (portfolio size, PAR, total deposits) belong to Modules 3/4/9, which
 * don't exist yet — listed under `pendingMetrics` rather than faked.
 */
async function getBranchPerformance(pool, { branchId, asOfDate = null }) {
  const glAccounts = await getBranchGlAccounts(pool, branchId);

  const [cashInHand, vault, income, expense, headcountResult] = await Promise.all([
    glPosting.getAccountBalance(pool, { accountId: glAccounts.cash_in_hand_account_id, asOfDate, branchId }),
    glPosting.getAccountBalance(pool, { accountId: glAccounts.vault_account_id, asOfDate, branchId }),
    glPosting.getAccountBalance(pool, { accountId: glAccounts.income_account_id, asOfDate, branchId }),
    glPosting.getAccountBalance(pool, { accountId: glAccounts.expense_account_id, asOfDate, branchId }),
    pool.query('SELECT COUNT(*)::int AS headcount FROM branch_staff_assignments WHERE branch_id = $1 AND end_date IS NULL', [
      branchId,
    ]),
  ]);

  return {
    branchId,
    asOfDate,
    cashInHandPesewas: cashInHand,
    vaultPesewas: vault,
    cashPositionPesewas: cashInHand + vault,
    incomePesewas: income,
    expensePesewas: expense,
    netIncomePesewas: income - expense,
    costToIncomeRatio: income > 0 ? expense / income : null,
    headcount: headcountResult.rows[0].headcount,
    pendingMetrics: ['portfolioSize', 'parBuckets', 'totalDeposits', 'profitability (needs allocated overhead from Module 9)'],
  };
}

async function compareBranchPerformance(pool, { branchIds, asOfDate = null }) {
  return Promise.all(branchIds.map((branchId) => getBranchPerformance(pool, { branchId, asOfDate })));
}

module.exports = {
  createBranch,
  getBranch,
  listBranches,
  updateBranch,
  changeBranchStatus,
  closeBranchOnApproval,
  registerBranchExecutionHandlers,
  createRegion,
  listRegions,
  createCluster,
  listClusters,
  assignStaff,
  listStaffAssignments,
  grantCrossBranchAccess,
  revokeCrossBranchAccess,
  listActiveCrossBranchGrants,
  initiateTransfer,
  getTransfer,
  confirmTransfer,
  cancelTransfer,
  getBranchPerformance,
  compareBranchPerformance,
  validateBranchCode,
  isValidStatusTransition,
  isGrantActive,
  glSubAccountCode,
  VALID_STATUS_TRANSITIONS,
  CONTROL_ACCOUNT_CODES,
  BranchValidationError,
  BranchNotFoundError,
  BranchImmutableCodeError,
  InvalidStatusTransitionError,
  BranchReconciliationError,
};
