'use strict';

const auditLog = require('../../shared/auditLog');

/**
 * Reference/base rates that FLOATING loan products link to (e.g. a
 * bank's own prime rate) — see migration 053_policy_rates.sql. Owned by
 * the loan module (not a shared service) since nothing outside loan
 * products consumes it today; if that changes, this is the seam to
 * promote into backend/src/shared/ the same way auditLog/approvalWorkflow/
 * glPosting were.
 *
 * Follows this codebase's established convention for a global (not
 * branch-owned) config entity — see complianceService.setReportTemplateStatus
 * and rbac.js's role/permission routes: creation doesn't call auditLog
 * (the row's own created_by/created_at already is the record), but any
 * change to an EXISTING row does, stamped with the acting user's own
 * home branch (`actorBranchId`) since audit_log requires a branchId and
 * this entity isn't itself branch-scoped.
 */

class PolicyRateValidationError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 400;
  }
}
class PolicyRateNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 404;
  }
}

const todayIso = () => new Date().toISOString().slice(0, 10);

async function createPolicyRate(pool, { code, name, rateBps, createdBy }) {
  if (!code || !name || !Number.isInteger(rateBps) || !createdBy) {
    throw new PolicyRateValidationError('code, name, rateBps (integer), and createdBy are required');
  }
  if (rateBps < 0) {
    throw new PolicyRateValidationError('rateBps must be a non-negative integer');
  }
  const { rows } = await pool.query(
    `INSERT INTO policy_rates (code, name, rate_bps, created_by) VALUES ($1, $2, $3, $4) RETURNING *`,
    [String(code).toUpperCase(), name, rateBps, createdBy]
  );
  return rows[0];
}

async function getPolicyRate(pool, policyRateId) {
  const { rows } = await pool.query('SELECT * FROM policy_rates WHERE id = $1', [policyRateId]);
  if (!rows[0]) throw new PolicyRateNotFoundError(`policy_rate ${policyRateId} not found`);
  return rows[0];
}

async function listPolicyRates(pool, { status } = {}) {
  const clauses = [];
  const params = [];
  if (status) {
    params.push(status);
    clauses.push(`status = $${params.length}`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await pool.query(`SELECT * FROM policy_rates ${where} ORDER BY code`, params);
  return rows;
}

/**
 * Changes a policy rate's current value, effective as of `effectiveDate`
 * (defaults to today). Writes a policy_rate_changes row (the
 * effective-dated history a future reset/reconstruction needs) AND an
 * audit_log entry (this codebase's universal before/after trail) — two
 * different kinds of record, not a duplicate of the same one; see the
 * migration comment.
 */
async function updatePolicyRateValue(pool, { policyRateId, rateBps, effectiveDate = todayIso(), changedBy, actorBranchId }) {
  if (!Number.isInteger(rateBps) || rateBps < 0) {
    throw new PolicyRateValidationError('rateBps must be a non-negative integer');
  }
  if (!changedBy || !actorBranchId) {
    throw new PolicyRateValidationError('changedBy and actorBranchId are required');
  }

  const before = await getPolicyRate(pool, policyRateId);
  if (before.rate_bps === rateBps) {
    return before; // no-op: nothing changed, nothing to log
  }

  const { rows } = await pool.query(
    `UPDATE policy_rates SET rate_bps = $1, updated_at = now() WHERE id = $2 RETURNING *`,
    [rateBps, policyRateId]
  );
  const after = rows[0];

  await pool.query(
    `INSERT INTO policy_rate_changes (policy_rate_id, old_rate_bps, new_rate_bps, effective_date, changed_by)
     VALUES ($1, $2, $3, $4, $5)`,
    [policyRateId, before.rate_bps, rateBps, effectiveDate, changedBy]
  );

  await auditLog.record(pool, {
    userId: changedBy,
    branchId: actorBranchId,
    action: 'loan.policy_rate_changed',
    entityType: 'policy_rate',
    entityId: policyRateId,
    beforeState: { rateBps: before.rate_bps },
    afterState: { rateBps: after.rate_bps, effectiveDate },
  });

  return after;
}

async function setPolicyRateStatus(pool, { policyRateId, status, changedBy, actorBranchId }) {
  if (!['active', 'inactive'].includes(status)) {
    throw new PolicyRateValidationError("status must be 'active' or 'inactive'");
  }
  if (!changedBy || !actorBranchId) {
    throw new PolicyRateValidationError('changedBy and actorBranchId are required');
  }
  const before = await getPolicyRate(pool, policyRateId);
  const { rows } = await pool.query(
    `UPDATE policy_rates SET status = $1, updated_at = now() WHERE id = $2 RETURNING *`,
    [status, policyRateId]
  );
  await auditLog.record(pool, {
    userId: changedBy,
    branchId: actorBranchId,
    action: 'loan.policy_rate_status_changed',
    entityType: 'policy_rate',
    entityId: policyRateId,
    beforeState: { status: before.status },
    afterState: { status: rows[0].status },
  });
  return rows[0];
}

async function listPolicyRateHistory(pool, { policyRateId }) {
  const { rows } = await pool.query(
    'SELECT * FROM policy_rate_changes WHERE policy_rate_id = $1 ORDER BY effective_date DESC, id DESC',
    [policyRateId]
  );
  return rows;
}

module.exports = {
  createPolicyRate,
  getPolicyRate,
  listPolicyRates,
  updatePolicyRateValue,
  setPolicyRateStatus,
  listPolicyRateHistory,
  PolicyRateValidationError,
  PolicyRateNotFoundError,
};
