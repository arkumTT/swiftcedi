'use strict';

const auditLog = require('./auditLog');

/**
 * Shared maker-checker approval-workflow service (Module 11). Every module
 * that needs dual-control approval calls `requestApproval()` /
 * `decide()` instead of reimplementing approval state — see
 * Decisions_Log.md "Shared Services".
 *
 * Callers are expected to pass a `db` that is a single pg Client/PoolClient
 * already inside a transaction (BEGIN'd by the caller) whenever `decide()`
 * may run an execute side effect (an explicit `execute` param, or an
 * action_type with a registered handler), so the approval decision and the
 * side effect it authorizes (e.g. a GL posting) commit or roll back
 * together. `backend/src/routes/approvals.js` does this for the generic
 * HTTP endpoint.
 */

class ApprovalValidationError extends Error {}
class ApprovalNotFoundError extends Error {}
class MakerCheckerViolationError extends Error {}

/**
 * Registry of action_type -> execute handler, so the ONE generic
 * `POST /approvals/:id/decide` HTTP endpoint can trigger a module-specific
 * side effect on approval without that module reimplementing its own
 * decide endpoint (which would mean duplicating the maker-checker HTTP
 * plumbing per module). A module registers its handler once at startup;
 * `decide()` looks it up by the request's `action_type` when the caller
 * doesn't pass an explicit `execute` (an explicit `execute` always wins —
 * this is what the unit tests exercise directly, without touching the
 * registry). See Decisions_Log.md "Shared Services" for the Module 1
 * addition this enabled (branch closure).
 */
const executionHandlers = new Map();

function registerExecutionHandler(actionType, handler) {
  executionHandlers.set(actionType, handler);
}

/**
 * Look up the approval threshold that applies to an action, preferring a
 * branch-specific row over the org-wide (branch_id IS NULL) row.
 */
async function getApplicableThreshold(db, { actionType, branchId }) {
  const { rows } = await db.query(
    `SELECT * FROM approval_thresholds
     WHERE action_type = $1 AND (branch_id = $2 OR branch_id IS NULL)
     ORDER BY branch_id NULLS LAST
     LIMIT 1`,
    [actionType, branchId]
  );
  return rows[0] || null;
}

/**
 * Pure decision function: given a threshold row (or null, meaning the
 * action isn't threshold-gated) and an amount, is approval required?
 * Kept side-effect-free and exported so it's directly unit-testable.
 */
function isApprovalRequired(threshold, amountPesewas) {
  if (!threshold) return false;
  const amount = Number(amountPesewas || 0);
  return amount >= Number(threshold.amount_threshold_pesewas);
}

function assertRequestApprovalParams({ actionType, entityType, branchId, requestedBy }) {
  const missing = [];
  if (!actionType) missing.push('actionType');
  if (!entityType) missing.push('entityType');
  if (!branchId) missing.push('branchId');
  if (!requestedBy) missing.push('requestedBy');
  if (missing.length > 0) {
    throw new ApprovalValidationError(`requestApproval missing required field(s): ${missing.join(', ')}`);
  }
}

/**
 * Create a pending approval request. Looks up the applicable threshold to
 * stamp `required_approver_role_id`, but does NOT decide whether approval
 * is "needed" — that's a caller-side decision via `isApprovalRequired()`
 * (e.g. a loan officer might only call this for disbursements above the
 * product's auto-approve limit). Once created, the request always requires
 * an explicit decide() — there is no silent auto-approve path.
 */
async function requestApproval(db, params) {
  assertRequestApprovalParams(params);

  const {
    actionType,
    entityType,
    entityId = null,
    branchId,
    requestedBy,
    amountPesewas = null,
    payload = null,
  } = params;

  const threshold = await getApplicableThreshold(db, { actionType, branchId });
  const requiredApproverRoleIds = threshold
    ? threshold.required_approver_role_ids
      || (threshold.required_approver_role_id ? [threshold.required_approver_role_id] : null)
    : null;
  const requiredApproverRoleId = requiredApproverRoleIds ? requiredApproverRoleIds[0] : null;

  const { rows } = await db.query(
    `INSERT INTO approval_requests
       (action_type, entity_type, entity_id, branch_id, amount_pesewas, payload, requested_by, required_approver_role_id, required_approver_role_ids, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
     RETURNING *`,
    [
      actionType,
      entityType,
      entityId === null ? null : String(entityId),
      branchId,
      amountPesewas,
      payload === null ? null : JSON.stringify(payload),
      requestedBy,
      requiredApproverRoleId,
      requiredApproverRoleIds,
    ]
  );

  const approvalRequest = rows[0];

  await auditLog.record(db, {
    userId: requestedBy,
    branchId,
    action: `${actionType}.approval_requested`,
    entityType: 'approval_request',
    entityId: approvalRequest.id,
    afterState: approvalRequest,
  });

  return approvalRequest;
}

/**
 * Approve or reject a pending request.
 *
 * @param {object} params
 * @param {number} params.approvalId
 * @param {number} params.decidedBy
 * @param {'approved'|'rejected'} params.decision
 * @param {string} [params.reason]
 * @param {(approvalRequest: object, db) => Promise<void>} [params.execute] -
 *   invoked only when decision === 'approved', for the caller to perform
 *   the side effect the approval authorizes (e.g. post the GL entry).
 *   Receives the same `db` client `decide()` was called with, so it can run
 *   further queries in the same transaction. If omitted, falls back to a
 *   handler registered for this request's `action_type` via
 *   `registerExecutionHandler()`, if any.
 */
async function decide(db, { approvalId, decidedBy, decision, reason = null, execute = null }) {
  if (!approvalId || !decidedBy) {
    throw new ApprovalValidationError('decide requires approvalId and decidedBy');
  }
  if (decision !== 'approved' && decision !== 'rejected') {
    throw new ApprovalValidationError(`decision must be 'approved' or 'rejected', got '${decision}'`);
  }

  const { rows: existingRows } = await db.query(
    'SELECT * FROM approval_requests WHERE id = $1 FOR UPDATE',
    [approvalId]
  );
  const existing = existingRows[0];
  if (!existing) {
    throw new ApprovalNotFoundError(`approval_request ${approvalId} not found`);
  }
  if (existing.status !== 'pending') {
    throw new ApprovalValidationError(`approval_request ${approvalId} is not pending (status: ${existing.status})`);
  }
  // Maker-checker: enforced here AND at the database layer (CHECK constraint
  // on approval_requests) as defense in depth.
  if (Number(existing.requested_by) === Number(decidedBy)) {
    throw new MakerCheckerViolationError('the requesting user cannot approve or reject their own request');
  }

  // Prefer the multi-role array; fall back to the singular column for rows
  // written before migration 059 that were never backfilled (shouldn't
  // happen post-migration, but keeps old data readable).
  const requiredRoleIds = existing.required_approver_role_ids
    || (existing.required_approver_role_id ? [existing.required_approver_role_id] : null);
  if (requiredRoleIds && requiredRoleIds.length > 0) {
    const { rows: userRows } = await db.query('SELECT role_id FROM users WHERE id = $1', [decidedBy]);
    const approver = userRows[0];
    const approverRoleId = approver ? Number(approver.role_id) : null;
    if (!approverRoleId || !requiredRoleIds.map(Number).includes(approverRoleId)) {
      throw new MakerCheckerViolationError(
        `user ${decidedBy} does not hold a role required to decide approval_request ${approvalId}`
      );
    }
  }

  const { rows } = await db.query(
    `UPDATE approval_requests
       SET status = $1, decided_by = $2, decided_at = now(), decision_reason = $3, updated_at = now()
     WHERE id = $4
     RETURNING *`,
    [decision, decidedBy, reason, approvalId]
  );
  const updated = rows[0];

  const handler = execute || executionHandlers.get(existing.action_type);
  if (decision === 'approved' && typeof handler === 'function') {
    await handler(updated, db);
  }

  await auditLog.record(db, {
    userId: decidedBy,
    branchId: existing.branch_id,
    action: `${existing.action_type}.approval_${decision}`,
    entityType: 'approval_request',
    entityId: approvalId,
    beforeState: existing,
    afterState: updated,
  });

  return updated;
}

/**
 * Powers every "approval queue" / "approval trail" screen (Admin's Access &
 * Approval Rules, the notification center, a loan/customer/branch closure's
 * own approval-trail view) — there was previously no way to list
 * `approval_requests` at all, only request/decide single rows by id.
 */
async function listApprovals(db, { status, actionType, entityType, branchId } = {}) {
  const clauses = [];
  const params = [];
  const add = (col, val) => {
    if (val === undefined || val === null) return;
    params.push(val);
    clauses.push(`${col} = $${params.length}`);
  };
  add('status', status);
  add('action_type', actionType);
  add('entity_type', entityType);
  add('branch_id', branchId);
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await db.query(
    `SELECT * FROM approval_requests ${where} ORDER BY created_at DESC`,
    params
  );
  return rows;
}

module.exports = {
  requestApproval,
  decide,
  getApplicableThreshold,
  isApprovalRequired,
  listApprovals,
  registerExecutionHandler,
  ApprovalValidationError,
  ApprovalNotFoundError,
  MakerCheckerViolationError,
};
