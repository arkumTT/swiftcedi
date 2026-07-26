'use strict';

const auditLog = require('../../shared/auditLog');

/**
 * Module 10: Agent & Field Operations. `field_agents` is a 1:1 extension
 * of a staff/user record (see migration 046's own comment) — Module 4's
 * susu_collections/agent_remittances already reference users(id)
 * directly, so this service bridges to that data via
 * `field_agents.user_id`, never by adding a foreign key the other
 * direction.
 */

class AgentValidationError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 400;
  }
}
class AgentNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 404;
  }
}
class AgentConflictError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 409;
  }
}
/** Distinct from AgentConflictError (409) so a mobile client can tell "too soon, don't retry yet" apart from an ordinary business-rule conflict. */
class AgentPingTooFrequentError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 429;
  }
}

const todayIso = () => new Date().toISOString().slice(0, 10);

// Minimum seconds between two accepted location pings for the SAME agent —
// an engineering/cost-control choice (mobile data usage for agents on
// limited connectivity), not a regulatory figure. Two minutes.
const MIN_PING_INTERVAL_SECONDS = 120;

// Default rolling retention window for agent_locations.
const DEFAULT_LOCATION_RETENTION_DAYS = 90;

// --- Field agent CRUD ---------------------------------------------------------

async function getFieldAgent(pool, agentId) {
  const { rows } = await pool.query('SELECT * FROM field_agents WHERE id = $1', [agentId]);
  if (!rows[0]) throw new AgentNotFoundError(`field_agent ${agentId} not found`);
  return rows[0];
}

async function listFieldAgents(pool, { branchId, status } = {}) {
  const clauses = [];
  const params = [];
  const add = (col, val) => {
    if (val === undefined || val === null) return;
    params.push(val);
    clauses.push(`${col} = $${params.length}`);
  };
  add('home_branch_id', branchId);
  add('status', status);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await pool.query(`SELECT * FROM field_agents ${where} ORDER BY id`, params);
  return rows;
}

/**
 * Registers an existing user as a field agent and opens their first
 * `agent_assignments` row in the same transaction — a field_agents row
 * never exists without a corresponding "current" assignment.
 */
async function createFieldAgent(pool, { userId, homeBranchId, territory = null, createdBy }) {
  if (!userId || !homeBranchId || !createdBy) {
    throw new AgentValidationError('userId, homeBranchId, and createdBy are required');
  }

  const client = await pool.connect();
  let agent;
  try {
    await client.query('BEGIN');

    const { rows: userRows } = await client.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (!userRows[0]) throw new AgentValidationError(`user ${userId} not found`);

    const { rows: agentRows } = await client.query(
      `INSERT INTO field_agents (user_id, home_branch_id, territory, created_by)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [userId, homeBranchId, territory, createdBy]
    );
    agent = agentRows[0];

    await client.query(
      `INSERT INTO agent_assignments (agent_id, branch_id, territory, assigned_by)
       VALUES ($1, $2, $3, $4)`,
      [agent.id, homeBranchId, territory, createdBy]
    );

    await auditLog.record(client, {
      userId: createdBy,
      branchId: homeBranchId,
      action: 'agent.created',
      entityType: 'field_agent',
      entityId: agent.id,
      afterState: agent,
    });

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      throw new AgentConflictError(`user ${userId} is already registered as a field agent`);
    }
    throw err;
  } finally {
    client.release();
  }

  return agent;
}

/**
 * `territory`/`status` are directly editable. `homeBranchId` is NOT —
 * changing an agent's branch must go through `reassignAgent` so the
 * assignment history stays complete (same "no silent edit of a
 * denormalized current-state field" rule `branchService.assignStaff`
 * already follows for `users.home_branch_id`).
 */
async function updateFieldAgent(pool, { agentId, updatedBy, fields }) {
  if (!updatedBy) throw new AgentValidationError('updatedBy is required');
  if (!fields || Object.keys(fields).length === 0) {
    throw new AgentValidationError('fields must include at least one change');
  }
  if (fields.homeBranchId !== undefined) {
    throw new AgentValidationError('homeBranchId cannot be changed directly; use reassignAgent instead');
  }

  const before = await getFieldAgent(pool, agentId);

  const setClauses = [];
  const params = [];
  if (fields.territory !== undefined) {
    params.push(fields.territory);
    setClauses.push(`territory = $${params.length}`);
  }
  if (fields.status !== undefined) {
    if (!['active', 'inactive'].includes(fields.status)) {
      throw new AgentValidationError("status must be 'active' or 'inactive'");
    }
    params.push(fields.status);
    setClauses.push(`status = $${params.length}`);
  }
  if (setClauses.length === 0) {
    throw new AgentValidationError('no recognized fields to update (territory, status)');
  }

  params.push(agentId);
  const { rows } = await pool.query(
    `UPDATE field_agents SET ${setClauses.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`,
    params
  );
  const agent = rows[0];

  await auditLog.record(pool, {
    userId: updatedBy,
    branchId: agent.home_branch_id,
    action: 'agent.updated',
    entityType: 'field_agent',
    entityId: agentId,
    beforeState: before,
    afterState: agent,
  });

  return agent;
}

// --- Assignment / reassignment history ---------------------------------------

/**
 * Closes the agent's current open assignment and opens a new one, then
 * syncs `field_agents.home_branch_id`/`territory` to match — same
 * close-then-open-then-sync-denormalized-field shape as
 * `branchService.assignStaff`.
 */
async function reassignAgent(pool, { agentId, newBranchId, territory = null, effectiveDate = todayIso(), reason = null, assignedBy }) {
  if (!agentId || !newBranchId || !assignedBy) {
    throw new AgentValidationError('agentId, newBranchId, and assignedBy are required');
  }

  const client = await pool.connect();
  let agent;
  try {
    await client.query('BEGIN');

    const { rows: agentRows } = await client.query('SELECT * FROM field_agents WHERE id = $1 FOR UPDATE', [agentId]);
    const before = agentRows[0];
    if (!before) throw new AgentNotFoundError(`field_agent ${agentId} not found`);

    await client.query(
      `UPDATE agent_assignments SET end_date = $1 WHERE agent_id = $2 AND end_date IS NULL`,
      [effectiveDate, agentId]
    );

    await client.query(
      `INSERT INTO agent_assignments (agent_id, branch_id, territory, start_date, assigned_by, reason)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [agentId, newBranchId, territory, effectiveDate, assignedBy, reason]
    );

    const { rows: updatedRows } = await client.query(
      `UPDATE field_agents SET home_branch_id = $1, territory = $2, updated_at = now() WHERE id = $3 RETURNING *`,
      [newBranchId, territory, agentId]
    );
    agent = updatedRows[0];

    await auditLog.record(client, {
      userId: assignedBy,
      branchId: newBranchId,
      action: 'agent.reassigned',
      entityType: 'field_agent',
      entityId: agentId,
      beforeState: { homeBranchId: before.home_branch_id, territory: before.territory },
      afterState: { homeBranchId: newBranchId, territory, reason },
    });

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return agent;
}

async function listAssignmentHistory(pool, { agentId }) {
  if (!agentId) throw new AgentValidationError('agentId is required');
  const { rows } = await pool.query(
    'SELECT * FROM agent_assignments WHERE agent_id = $1 ORDER BY start_date DESC, id DESC',
    [agentId]
  );
  return rows;
}

// --- Location tracking ---------------------------------------------------------

/**
 * Records a GPS ping, rejecting one submitted too soon after the agent's
 * last accepted ping (module prompt's own "respect a reasonable ping
 * interval... to control mobile data costs" rule) — a 429 rather than a
 * silent no-op, so a client knows definitively not to bother retrying yet
 * rather than wondering whether its ping was recorded.
 */
async function recordLocationPing(pool, { agentId, gpsLat, gpsLng, recordedAt = new Date().toISOString() }) {
  if (!agentId || gpsLat === undefined || gpsLng === undefined) {
    throw new AgentValidationError('agentId, gpsLat, and gpsLng are required');
  }
  if (gpsLat < -90 || gpsLat > 90 || gpsLng < -180 || gpsLng > 180) {
    throw new AgentValidationError('gpsLat must be between -90 and 90 and gpsLng between -180 and 180');
  }

  const { rows: lastRows } = await pool.query(
    'SELECT recorded_at FROM agent_locations WHERE agent_id = $1 ORDER BY recorded_at DESC LIMIT 1',
    [agentId]
  );
  if (lastRows[0]) {
    const secondsSinceLast = (new Date(recordedAt) - new Date(lastRows[0].recorded_at)) / 1000;
    if (secondsSinceLast < MIN_PING_INTERVAL_SECONDS) {
      throw new AgentPingTooFrequentError(
        `ping rejected: only ${Math.floor(secondsSinceLast)}s since the last accepted ping (minimum ${MIN_PING_INTERVAL_SECONDS}s)`
      );
    }
  }

  const { rows } = await pool.query(
    `INSERT INTO agent_locations (agent_id, gps_lat, gps_lng, recorded_at)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [agentId, gpsLat, gpsLng, recordedAt]
  );
  return rows[0];
}

async function getCurrentLocation(pool, { agentId }) {
  if (!agentId) throw new AgentValidationError('agentId is required');
  const { rows } = await pool.query(
    'SELECT * FROM agent_locations WHERE agent_id = $1 ORDER BY recorded_at DESC LIMIT 1',
    [agentId]
  );
  return rows[0] || null;
}

async function getLocationHistory(pool, { agentId, fromDate, toDate }) {
  if (!agentId) throw new AgentValidationError('agentId is required');
  const params = [agentId];
  let where = 'agent_id = $1';
  if (fromDate) {
    params.push(fromDate);
    where += ` AND recorded_at >= $${params.length}`;
  }
  if (toDate) {
    params.push(toDate);
    where += ` AND recorded_at <= $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT * FROM agent_locations WHERE ${where} ORDER BY recorded_at DESC`,
    params
  );
  return rows;
}

/**
 * Deletes location pings older than the retention window. A real,
 * callable primitive — actually SCHEDULING it to run nightly/weekly is a
 * Module 12 (System Administration) concern, same deferral already used
 * for Module 9's daily_metrics_snapshot. See Decisions_Log.md.
 */
async function purgeOldLocations(pool, { olderThanDays = DEFAULT_LOCATION_RETENTION_DAYS } = {}) {
  const { rowCount } = await pool.query(
    `DELETE FROM agent_locations WHERE recorded_at < now() - ($1 || ' days')::interval`,
    [olderThanDays]
  );
  return { deletedCount: rowCount };
}

// --- End-of-day reconciliation -------------------------------------------------

/**
 * Expected = this agent's field-collected susu transactions for the date
 * (SUM of susu_collections.amount_pesewas via the users(id) bridge — see
 * this file's header comment). Received = what the branch cashier
 * actually recorded banking that date (SUM of agent_remittances for the
 * SAME date). These are independently-dated events (collection_date vs
 * remitted_on), so a real variance appears whenever an agent is still
 * holding field cash overnight or remits a different day's collections —
 * NOT a re-derivation of the same number (see migration 046's comment for
 * why that distinction matters). "Any field loan repayments" from the
 * module prompt are NOT included — loanService has no field-collection/
 * agent concept yet to reconcile against. See Decisions_Log.md.
 *
 * Never auto-resolves a variance (module prompt's own rule): status is
 * 'matched' only when variance = 0, else 'pending_review', and only
 * `resolveReconciliation` may move a row to 'resolved'.
 */
async function runDailyReconciliation(pool, { agentId, date = todayIso(), createdBy }) {
  if (!agentId || !createdBy) throw new AgentValidationError('agentId and createdBy are required');

  const agent = await getFieldAgent(pool, agentId);

  const { rows: expectedRows } = await pool.query(
    `SELECT COALESCE(SUM(c.amount_pesewas), 0)::bigint AS total
       FROM susu_collections c
       JOIN field_agents fa ON fa.user_id = c.agent_id
      WHERE fa.id = $1 AND c.collection_date = $2`,
    [agentId, date]
  );
  const { rows: receivedRows } = await pool.query(
    `SELECT COALESCE(SUM(r.amount_pesewas), 0)::bigint AS total
       FROM agent_remittances r
       JOIN field_agents fa ON fa.user_id = r.agent_id
      WHERE fa.id = $1 AND r.remitted_on = $2`,
    [agentId, date]
  );

  const expectedAmountPesewas = Number(expectedRows[0].total);
  const receivedAmountPesewas = Number(receivedRows[0].total);
  const variancePesewas = expectedAmountPesewas - receivedAmountPesewas;
  const status = variancePesewas === 0 ? 'matched' : 'pending_review';

  const { rows } = await pool.query(
    `INSERT INTO agent_reconciliations
       (agent_id, reconciliation_date, expected_amount_pesewas, received_amount_pesewas, variance_pesewas, status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (agent_id, reconciliation_date)
     DO UPDATE SET
       expected_amount_pesewas = EXCLUDED.expected_amount_pesewas,
       received_amount_pesewas = EXCLUDED.received_amount_pesewas,
       variance_pesewas = EXCLUDED.variance_pesewas,
       status = CASE WHEN agent_reconciliations.status = 'resolved' THEN agent_reconciliations.status ELSE EXCLUDED.status END,
       updated_at = now()
     RETURNING *`,
    [agentId, date, expectedAmountPesewas, receivedAmountPesewas, variancePesewas, status, createdBy]
  );
  const reconciliation = rows[0];

  await auditLog.record(pool, {
    userId: createdBy,
    branchId: agent.home_branch_id,
    action: 'agent.reconciliation_run',
    entityType: 'agent_reconciliation',
    entityId: reconciliation.id,
    afterState: reconciliation,
  });

  return reconciliation;
}

/** Runs the daily reconciliation for every active agent currently assigned to a branch. */
async function runBranchDailyReconciliation(pool, { branchId, date = todayIso(), createdBy }) {
  if (!branchId || !createdBy) throw new AgentValidationError('branchId and createdBy are required');
  const agents = await listFieldAgents(pool, { branchId, status: 'active' });
  const results = [];
  for (const agent of agents) {
    results.push(await runDailyReconciliation(pool, { agentId: agent.id, date, createdBy }));
  }
  return results;
}

async function listReconciliations(pool, { branchId, agentId, status, fromDate, toDate } = {}) {
  const params = [];
  const clauses = [];
  let joinBranch = '';
  if (branchId) {
    joinBranch = 'JOIN field_agents fa ON fa.id = ar.agent_id';
    params.push(branchId);
    clauses.push(`fa.home_branch_id = $${params.length}`);
  }
  const add = (col, val) => {
    if (val === undefined || val === null) return;
    params.push(val);
    clauses.push(`ar.${col} = $${params.length}`);
  };
  add('agent_id', agentId);
  add('status', status);
  if (fromDate) {
    params.push(fromDate);
    clauses.push(`ar.reconciliation_date >= $${params.length}`);
  }
  if (toDate) {
    params.push(toDate);
    clauses.push(`ar.reconciliation_date <= $${params.length}`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT ar.* FROM agent_reconciliations ar ${joinBranch} ${where} ORDER BY ar.reconciliation_date DESC, ar.id DESC`,
    params
  );
  return rows;
}

/** Explicit, human-only transition out of 'pending_review' — see this file's header comment on never auto-resolving. */
async function resolveReconciliation(pool, { reconciliationId, resolvedBy, resolutionNotes }) {
  if (!resolvedBy || !resolutionNotes) {
    throw new AgentValidationError('resolvedBy and resolutionNotes are required');
  }

  const { rows: beforeRows } = await pool.query('SELECT * FROM agent_reconciliations WHERE id = $1', [reconciliationId]);
  const before = beforeRows[0];
  if (!before) throw new AgentNotFoundError(`agent_reconciliation ${reconciliationId} not found`);
  if (before.status !== 'pending_review') {
    throw new AgentConflictError(`agent_reconciliation ${reconciliationId} is not pending review (status: ${before.status})`);
  }

  const { rows } = await pool.query(
    `UPDATE agent_reconciliations
       SET status = 'resolved', reviewed_by = $1, reviewed_at = now(), resolution_notes = $2, updated_at = now()
     WHERE id = $3 RETURNING *`,
    [resolvedBy, resolutionNotes, reconciliationId]
  );
  const reconciliation = rows[0];

  const agent = await getFieldAgent(pool, before.agent_id);
  await auditLog.record(pool, {
    userId: resolvedBy,
    branchId: agent.home_branch_id,
    action: 'agent.reconciliation_resolved',
    entityType: 'agent_reconciliation',
    entityId: reconciliationId,
    beforeState: { status: before.status },
    afterState: { status: reconciliation.status, resolutionNotes },
  });

  return reconciliation;
}

module.exports = {
  getFieldAgent,
  listFieldAgents,
  createFieldAgent,
  updateFieldAgent,
  reassignAgent,
  listAssignmentHistory,
  recordLocationPing,
  getCurrentLocation,
  getLocationHistory,
  purgeOldLocations,
  runDailyReconciliation,
  runBranchDailyReconciliation,
  listReconciliations,
  resolveReconciliation,
  MIN_PING_INTERVAL_SECONDS,
  DEFAULT_LOCATION_RETENTION_DAYS,
  AgentValidationError,
  AgentNotFoundError,
  AgentConflictError,
  AgentPingTooFrequentError,
};
