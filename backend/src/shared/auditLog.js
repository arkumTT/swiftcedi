'use strict';

/**
 * Shared audit-log service (Module 11). This is the ONLY code path that may
 * write to the `audit_log` table — every other module calls `record()`
 * instead of writing audit rows itself. The table itself is also immutable
 * at the database layer (see migration 004_audit_log.sql), so this module
 * never exposes an update/delete.
 */

class AuditLogValidationError extends Error {}

const REQUIRED_FIELDS = ['branchId', 'action', 'entityType', 'entityId'];

function validateEntry(entry) {
  const missing = REQUIRED_FIELDS.filter((field) => {
    const value = entry[field];
    return value === undefined || value === null || value === '';
  });
  if (missing.length > 0) {
    throw new AuditLogValidationError(`audit log entry missing required field(s): ${missing.join(', ')}`);
  }
}

/**
 * Record an immutable audit log entry.
 *
 * @param {import('pg').ClientBase} db - a pg Client/Pool/PoolClient (or a
 *   test double exposing an async `query(sql, params)`), ideally the same
 *   client the caller's transaction is running on so the audit row commits
 *   or rolls back atomically with the write it's auditing.
 * @param {object} entry
 * @param {number|null} [entry.userId] - null only for system-initiated actions.
 * @param {number} entry.branchId
 * @param {string} entry.action - e.g. 'loan.disburse', 'gl.post_journal'.
 * @param {string} entry.entityType
 * @param {string|number} entry.entityId
 * @param {object|null} [entry.beforeState]
 * @param {object|null} [entry.afterState]
 * @param {string|null} [entry.ipAddress]
 */
async function record(db, entry) {
  validateEntry(entry);

  const {
    userId = null,
    branchId,
    action,
    entityType,
    entityId,
    beforeState = null,
    afterState = null,
    ipAddress = null,
  } = entry;

  const { rows } = await db.query(
    `INSERT INTO audit_log
       (user_id, branch_id, action, entity_type, entity_id, before_state, after_state, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      userId,
      branchId,
      action,
      entityType,
      String(entityId),
      beforeState === null ? null : JSON.stringify(beforeState),
      afterState === null ? null : JSON.stringify(afterState),
      ipAddress,
    ]
  );

  return rows[0];
}

/**
 * Query audit log entries. Filters are all optional and combined with AND.
 *
 * @param {import('pg').ClientBase} db
 * @param {object} [filters]
 * @param {number} [filters.userId]
 * @param {number} [filters.branchId]
 * @param {string} [filters.entityType]
 * @param {string|number} [filters.entityId]
 * @param {Date|string} [filters.from] - inclusive lower bound on created_at.
 * @param {Date|string} [filters.to] - inclusive upper bound on created_at.
 * @param {object} [pagination]
 * @param {number} [pagination.limit=50]
 * @param {number} [pagination.offset=0]
 */
async function query(db, filters = {}, pagination = {}) {
  const { userId, branchId, entityType, entityId, from, to } = filters;
  const { limit = 50, offset = 0 } = pagination;

  const clauses = [];
  const params = [];

  const addClause = (column, value) => {
    if (value === undefined || value === null) return;
    params.push(value);
    clauses.push(`${column} = $${params.length}`);
  };

  addClause('user_id', userId);
  addClause('branch_id', branchId);
  addClause('entity_type', entityType);
  if (entityId !== undefined && entityId !== null) addClause('entity_id', String(entityId));

  if (from) {
    params.push(from);
    clauses.push(`created_at >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    clauses.push(`created_at <= $${params.length}`);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  params.push(Math.min(Number(limit) || 50, 500));
  const limitParam = `$${params.length}`;
  params.push(Number(offset) || 0);
  const offsetParam = `$${params.length}`;

  const { rows } = await db.query(
    `SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT ${limitParam} OFFSET ${offsetParam}`,
    params
  );

  return rows;
}

module.exports = { record, query, AuditLogValidationError };
