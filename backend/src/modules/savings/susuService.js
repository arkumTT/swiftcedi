'use strict';

const auditLog = require('../../shared/auditLog');
const glPosting = require('../../shared/glPosting');
const savingsMath = require('./savingsMath');
const savingsService = require('./savingsService');

/**
 * Module 4: Susu (periodic informal collection) accounts, field
 * collections, agent commission, and cycle payout.
 *
 * GL mapping (see Decisions_Log.md):
 *   Field collection   Dr Cash with Agents (1030)      Cr Susu Deposits (2010)
 *   Agent remittance   Dr Cash in Hand (1000)          Cr Cash with Agents (1030)
 *   Commission accrual Dr Agent Commission Expense     Cr Agent Commission Payable
 *   Cycle payout       Dr Susu Deposits                Cr Customer Deposits (into savings)
 *
 * The Cash-with-Agents leg is the whole point: cash collected in the field
 * is NOT branch cash until the agent banks it, and 1030's balance is
 * exactly "what agents are currently holding" — the figure Module 10's
 * end-of-day reconciliation checks against what the cashier received.
 */

class SusuValidationError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 400;
  }
}
class SusuNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 404;
  }
}
class SusuConflictError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 409;
  }
}

const todayIso = () => new Date().toISOString().slice(0, 10);

async function getSusuAccount(db, susuAccountId) {
  const { rows } = await db.query('SELECT * FROM susu_accounts WHERE id = $1', [susuAccountId]);
  if (!rows[0]) throw new SusuNotFoundError(`susu_account ${susuAccountId} not found`);
  return rows[0];
}

async function listSusuAccounts(pool, { customerId, branchId, agentId, status } = {}) {
  const clauses = [];
  const params = [];
  const add = (col, val) => {
    if (val === undefined || val === null) return;
    params.push(val);
    clauses.push(`${col} = $${params.length}`);
  };
  add('customer_id', customerId);
  add('branch_id', branchId);
  add('assigned_agent_id', agentId);
  add('status', status);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await pool.query(`SELECT * FROM susu_accounts ${where} ORDER BY id`, params);
  return rows;
}

async function createSusuAccount(pool, params) {
  const {
    customerId,
    cycleLengthDays,
    expectedCollectionPesewas,
    targetAmountPesewas,
    commissionRateBps = 0,
    assignedAgentId = null,
    payoutSavingsAccountId = null,
    cycleStartDate = todayIso(),
    createdBy,
  } = params;

  if (!customerId || !cycleLengthDays || !expectedCollectionPesewas || !targetAmountPesewas || !createdBy) {
    throw new SusuValidationError(
      'customerId, cycleLengthDays, expectedCollectionPesewas, targetAmountPesewas, and createdBy are required'
    );
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: customerRows } = await client.query('SELECT * FROM customers WHERE id = $1', [customerId]);
    const customer = customerRows[0];
    if (!customer) throw new SusuValidationError(`customer ${customerId} not found`);
    if (customer.status !== 'active') throw new SusuConflictError(`customer ${customerId} is not active`);
    if (customer.kyc_status !== 'verified') {
      throw new SusuConflictError(`customer ${customerId} must be KYC-verified before opening a susu account`);
    }

    if (payoutSavingsAccountId) {
      const { rows: savRows } = await client.query('SELECT * FROM savings_accounts WHERE id = $1', [payoutSavingsAccountId]);
      if (!savRows[0]) throw new SusuValidationError(`savings_account ${payoutSavingsAccountId} not found`);
      if (Number(savRows[0].customer_id) !== Number(customerId)) {
        throw new SusuValidationError('payoutSavingsAccountId must belong to the same customer');
      }
    }

    const accountNo = await savingsService.generateAccountNo(client, customer.branch_id, 'SUSU');
    const cycleEndDate = savingsMath.addDaysToDateString(cycleStartDate, cycleLengthDays);

    const { rows } = await client.query(
      `INSERT INTO susu_accounts
         (account_no, customer_id, branch_id, payout_savings_account_id, cycle_length_days,
          expected_collection_pesewas, target_amount_pesewas, commission_rate_bps, assigned_agent_id,
          cycle_start_date, cycle_end_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [
        accountNo,
        customerId,
        customer.branch_id,
        payoutSavingsAccountId,
        cycleLengthDays,
        expectedCollectionPesewas,
        targetAmountPesewas,
        commissionRateBps,
        assignedAgentId,
        cycleStartDate,
        cycleEndDate,
        createdBy,
      ]
    );
    const account = rows[0];

    await auditLog.record(client, {
      userId: createdBy,
      branchId: account.branch_id,
      action: 'susu.account_created',
      entityType: 'susu_account',
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

/**
 * Records a field collection. `idempotencyKey` is REQUIRED and unique —
 * an agent retrying over a flaky connection gets the original collection
 * back (with `idempotentReplay: true`) rather than double-posting. That is
 * the whole low-connectivity tolerance guarantee, enforced by a UNIQUE
 * index rather than by hoping the client behaves.
 */
async function recordCollection(pool, params) {
  const {
    susuAccountId,
    agentId,
    amountPesewas,
    idempotencyKey,
    collectionDate = todayIso(),
    gpsLat = null,
    gpsLng = null,
  } = params;

  if (!susuAccountId || !agentId || !idempotencyKey) {
    throw new SusuValidationError('susuAccountId, agentId, and idempotencyKey are required');
  }
  if (!Number.isInteger(amountPesewas) || amountPesewas <= 0) {
    throw new SusuValidationError('amountPesewas must be a positive integer');
  }

  const client = await pool.connect();
  let context;
  try {
    await client.query('BEGIN');

    const { rows: existing } = await client.query('SELECT * FROM susu_collections WHERE idempotency_key = $1', [
      idempotencyKey,
    ]);
    if (existing[0]) {
      await client.query('ROLLBACK');
      const { rows: commissionRows } = await pool.query('SELECT * FROM susu_commissions WHERE collection_id = $1', [
        existing[0].id,
      ]);
      return { collection: existing[0], commission: commissionRows[0] || null, idempotentReplay: true };
    }

    const { rows: accountRows } = await client.query('SELECT * FROM susu_accounts WHERE id = $1 FOR UPDATE', [
      susuAccountId,
    ]);
    const account = accountRows[0];
    if (!account) throw new SusuNotFoundError(`susu_account ${susuAccountId} not found`);
    if (account.status !== 'active') {
      throw new SusuConflictError(`susu_account ${susuAccountId} is not accepting collections (status: ${account.status})`);
    }

    const { rows: collectionRows } = await client.query(
      `INSERT INTO susu_collections
         (susu_account_id, agent_id, amount_pesewas, collection_date, gps_lat, gps_lng, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [susuAccountId, agentId, amountPesewas, collectionDate, gpsLat, gpsLng, idempotencyKey]
    );
    const collection = collectionRows[0];

    const collectedAfter = Number(account.collected_pesewas) + amountPesewas;
    await client.query('UPDATE susu_accounts SET collected_pesewas = $1, updated_at = now() WHERE id = $2', [
      collectedAfter,
      susuAccountId,
    ]);

    const commissionPesewas = savingsMath.computeCommissionPesewas(amountPesewas, account.commission_rate_bps);
    let commission = null;
    if (commissionPesewas > 0) {
      const { rows: commissionRows } = await client.query(
        `INSERT INTO susu_commissions (susu_account_id, collection_id, agent_id, amount_pesewas, basis)
         VALUES ($1, $2, $3, $4, 'per_collection') RETURNING *`,
        [susuAccountId, collection.id, agentId, commissionPesewas]
      );
      commission = commissionRows[0];
    }

    const glAccounts = await savingsService.getBranchGlAccounts(client, account.branch_id);
    context = { account, collection, commission, commissionPesewas, glAccounts, collectedAfter };

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const { account, collection, commission, commissionPesewas, glAccounts, collectedAfter } = context;
  const branchId = account.branch_id;

  const lines = [
    { accountId: glAccounts.cash_with_agents_account_id, debitPesewas: amountPesewas, branchId },
    { accountId: glAccounts.susu_deposits_account_id, creditPesewas: amountPesewas, branchId },
  ];
  const journalEntry = await glPosting.postJournalEntry(pool, {
    branchId,
    reference: `SUSU-${collection.id}-COL`,
    description: `Susu collection on ${account.account_no}`,
    entryDate: collectionDate,
    sourceModule: 'susu',
    createdBy: agentId,
    lines,
  });
  await pool.query('UPDATE susu_collections SET journal_entry_id = $1 WHERE id = $2', [journalEntry.id, collection.id]);

  let commissionJournalEntry = null;
  if (commissionPesewas > 0) {
    commissionJournalEntry = await glPosting.postJournalEntry(pool, {
      branchId,
      reference: `SUSU-${collection.id}-COMM`,
      description: `Agent commission on collection ${collection.id}`,
      entryDate: collectionDate,
      sourceModule: 'susu',
      createdBy: agentId,
      lines: [
        { accountId: glAccounts.agent_commission_expense_account_id, debitPesewas: commissionPesewas, branchId },
        { accountId: glAccounts.agent_commission_payable_account_id, creditPesewas: commissionPesewas, branchId },
      ],
    });
    await pool.query('UPDATE susu_commissions SET journal_entry_id = $1 WHERE id = $2', [
      commissionJournalEntry.id,
      commission.id,
    ]);
  }

  await auditLog.record(pool, {
    userId: agentId,
    branchId,
    action: 'susu.collection_recorded',
    entityType: 'susu_account',
    entityId: susuAccountId,
    afterState: { collectionId: collection.id, amountPesewas, collectedAfter, commissionPesewas },
  });

  return {
    collection: { ...collection, journal_entry_id: journalEntry.id },
    commission,
    commissionPesewas,
    collectedPesewas: collectedAfter,
    idempotentReplay: false,
  };
}

async function listCollections(pool, { susuAccountId, agentId, from, to, unremittedOnly = false } = {}) {
  const clauses = [];
  const params = [];
  const add = (col, val) => {
    if (val === undefined || val === null) return;
    params.push(val);
    clauses.push(`${col} = $${params.length}`);
  };
  add('susu_account_id', susuAccountId);
  add('agent_id', agentId);
  if (from) {
    params.push(from);
    clauses.push(`collection_date >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    clauses.push(`collection_date <= $${params.length}`);
  }
  if (unremittedOnly) clauses.push('remittance_id IS NULL');
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await pool.query(`SELECT * FROM susu_collections ${where} ORDER BY collection_date, id`, params);
  return rows;
}

/**
 * An agent banks their field cash at the branch: moves Cash with Agents
 * -> Cash in Hand and stamps the covered collections with the remittance
 * id. Module 10's reconciliation compares this against what the cashier
 * actually counted; because each collection can only be attached to one
 * remittance (remittance_id is set once and then immutable), the same
 * collection can never be reconciled twice.
 */
async function recordRemittance(pool, { agentId, branchId, receivedBy, remittedOn = todayIso(), collectionIds = null }) {
  if (!agentId || !branchId || !receivedBy) {
    throw new SusuValidationError('agentId, branchId, and receivedBy are required');
  }

  const client = await pool.connect();
  let context;
  try {
    await client.query('BEGIN');

    const params = [agentId, branchId];
    let filter = '';
    if (collectionIds && collectionIds.length > 0) {
      params.push(collectionIds);
      filter = `AND c.id = ANY($${params.length})`;
    }
    const { rows: collections } = await client.query(
      `SELECT c.* FROM susu_collections c
         JOIN susu_accounts s ON s.id = c.susu_account_id
        WHERE c.agent_id = $1 AND s.branch_id = $2 AND c.remittance_id IS NULL ${filter}
        FOR UPDATE OF c`,
      params
    );
    if (collections.length === 0) {
      throw new SusuConflictError(`agent ${agentId} has no unremitted collections at branch ${branchId}`);
    }

    const amountPesewas = collections.reduce((sum, c) => sum + Number(c.amount_pesewas), 0);
    const { rows: remittanceRows } = await client.query(
      `INSERT INTO agent_remittances (agent_id, branch_id, amount_pesewas, collection_count, remitted_on, received_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [agentId, branchId, amountPesewas, collections.length, remittedOn, receivedBy]
    );
    const remittance = remittanceRows[0];

    await client.query('UPDATE susu_collections SET remittance_id = $1 WHERE id = ANY($2)', [
      remittance.id,
      collections.map((c) => c.id),
    ]);

    const glAccounts = await savingsService.getBranchGlAccounts(client, branchId);
    context = { remittance, glAccounts, amountPesewas, count: collections.length };

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const { remittance, glAccounts, amountPesewas, count } = context;
  const journalEntry = await glPosting.postJournalEntry(pool, {
    branchId,
    reference: `SUSU-REM-${remittance.id}`,
    description: `Agent ${agentId} remitted ${count} collection(s)`,
    entryDate: remittedOn,
    sourceModule: 'susu',
    createdBy: receivedBy,
    lines: [
      { accountId: glAccounts.cash_in_hand_account_id, debitPesewas: amountPesewas, branchId },
      { accountId: glAccounts.cash_with_agents_account_id, creditPesewas: amountPesewas, branchId },
    ],
  });
  await pool.query('UPDATE agent_remittances SET journal_entry_id = $1 WHERE id = $2', [journalEntry.id, remittance.id]);

  await auditLog.record(pool, {
    userId: receivedBy,
    branchId,
    action: 'susu.remittance_recorded',
    entityType: 'agent_remittance',
    entityId: remittance.id,
    afterState: { ...remittance, journalEntryId: journalEntry.id },
  });

  return { ...remittance, journal_entry_id: journalEntry.id };
}

/**
 * Closes a cycle. The outcome is 'completed' if the target was reached,
 * 'uncompleted' otherwise — the spec's required status split. Note this
 * does NOT pay out; payout is a separate explicit step so an uncompleted
 * cycle can be settled on different terms if the business decides to.
 */
async function completeCycle(pool, { susuAccountId, completedBy }) {
  if (!completedBy) throw new SusuValidationError('completedBy is required');
  const account = await getSusuAccount(pool, susuAccountId);
  if (account.status !== 'active') {
    throw new SusuConflictError(`susu_account ${susuAccountId} is not active (status: ${account.status})`);
  }

  const outcome = savingsMath.resolveCycleOutcome(account.collected_pesewas, account.target_amount_pesewas);
  const { rows } = await pool.query(
    'UPDATE susu_accounts SET status = $1, updated_at = now() WHERE id = $2 RETURNING *',
    [outcome, susuAccountId]
  );

  await auditLog.record(pool, {
    userId: completedBy,
    branchId: account.branch_id,
    action: 'susu.cycle_completed',
    entityType: 'susu_account',
    entityId: susuAccountId,
    beforeState: { status: account.status },
    afterState: { status: outcome, collectedPesewas: account.collected_pesewas, targetPesewas: account.target_amount_pesewas },
  });

  return rows[0];
}

/**
 * Pays the collected proceeds into the customer's savings account and
 * settles the susu account. Works for both 'completed' and 'uncompleted'
 * cycles — an uncompleted cycle still owes the customer whatever they
 * actually saved.
 *
 *   Dr Susu Deposits      collected
 *     Cr Customer Deposits  collected   (the savings subledger credit)
 */
async function payOutCycle(pool, { susuAccountId, paidBy, payoutSavingsAccountId = null, entryDate = todayIso() }) {
  if (!paidBy) throw new SusuValidationError('paidBy is required');
  const account = await getSusuAccount(pool, susuAccountId);
  if (account.status !== 'completed' && account.status !== 'uncompleted') {
    throw new SusuConflictError(
      `susu_account ${susuAccountId} must have a finished cycle before payout (status: ${account.status})`
    );
  }

  const collected = Number(account.collected_pesewas);
  if (collected <= 0) throw new SusuConflictError(`susu_account ${susuAccountId} has nothing to pay out`);

  const targetSavingsId = payoutSavingsAccountId || account.payout_savings_account_id;
  if (!targetSavingsId) {
    throw new SusuValidationError('no payout savings account configured — pass payoutSavingsAccountId');
  }
  const savingsAccount = await savingsService.getAccount(pool, targetSavingsId);
  if (Number(savingsAccount.customer_id) !== Number(account.customer_id)) {
    throw new SusuValidationError('payout savings account must belong to the same customer');
  }

  // Credits the savings subledger and posts the susu-liability -> deposit-liability transfer.
  const movement = await savingsService.applyMovement(pool, {
    accountId: targetSavingsId,
    txnType: 'susu_payout',
    deltaPesewas: collected,
    description: `Susu cycle payout from ${account.account_no}`,
    createdBy: paidBy,
    entryDate,
    reference: `SUSU-${susuAccountId}-PAYOUT`,
    buildGlLines: ({ glAccounts, branchId }) => [
      { accountId: glAccounts.susu_deposits_account_id, debitPesewas: collected, branchId },
      { accountId: glAccounts.customer_deposits_account_id, creditPesewas: collected, branchId },
    ],
  });

  const { rows } = await pool.query(
    "UPDATE susu_accounts SET status = 'paid_out', closed_at = now(), updated_at = now() WHERE id = $1 RETURNING *",
    [susuAccountId]
  );

  await auditLog.record(pool, {
    userId: paidBy,
    branchId: account.branch_id,
    action: 'susu.cycle_paid_out',
    entityType: 'susu_account',
    entityId: susuAccountId,
    beforeState: { status: account.status },
    afterState: { status: 'paid_out', paidPesewas: collected, savingsAccountId: targetSavingsId },
  });

  return { susuAccount: rows[0], paidPesewas: collected, savingsTransaction: movement.transaction };
}

async function getAgentCommissionSummary(pool, { agentId, from = null, to = null }) {
  const params = [agentId];
  let where = 'agent_id = $1';
  if (from) {
    params.push(from);
    where += ` AND created_at >= $${params.length}`;
  }
  if (to) {
    params.push(to);
    where += ` AND created_at <= $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS commission_count,
            COALESCE(SUM(amount_pesewas), 0)::bigint AS total_pesewas,
            COALESCE(SUM(CASE WHEN paid_at IS NULL THEN amount_pesewas ELSE 0 END), 0)::bigint AS unpaid_pesewas
       FROM susu_commissions WHERE ${where}`,
    params
  );
  return {
    agentId: Number(agentId),
    commissionCount: rows[0].commission_count,
    totalPesewas: Number(rows[0].total_pesewas),
    unpaidPesewas: Number(rows[0].unpaid_pesewas),
  };
}

module.exports = {
  createSusuAccount,
  getSusuAccount,
  listSusuAccounts,
  recordCollection,
  listCollections,
  recordRemittance,
  completeCycle,
  payOutCycle,
  getAgentCommissionSummary,
  SusuValidationError,
  SusuNotFoundError,
  SusuConflictError,
};
