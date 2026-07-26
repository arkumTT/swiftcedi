'use strict';

const auditLog = require('../../shared/auditLog');
const approvalWorkflow = require('../../shared/approvalWorkflow');
const creditBureauClient = require('./creditBureauClient');

/**
 * Module 2: Customer & CRM. Uses the Module 11 shared services (auditLog,
 * approvalWorkflow) exactly as documented in Decisions_Log.md — account
 * closure is maker-checker gated via approvalWorkflow.registerExecutionHandler,
 * the same pattern Module 1 established for branch closure.
 */

class CustomerValidationError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 400;
  }
}
class CustomerNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 404;
  }
}
class CustomerConflictError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 409;
  }
}

// --- Pure helpers (no db) -------------------------------------------------

const GHANA_CARD_PATTERN = /^GHA-\d{9}-\d$/;

/**
 * NIA Ghana Card format: GHA-XXXXXXXXX-X (9 digits, 1 check digit). This is
 * the publicly documented format, not a figure that changes — but flagged
 * in Decisions_Log.md Open Questions for verification against the current
 * official NIA spec before this ships, same caution CLAUDE.md asks for
 * regulatory figures.
 */
function validateGhanaCardNo(raw) {
  const code = String(raw || '').trim().toUpperCase();
  if (!GHANA_CARD_PATTERN.test(code)) {
    throw new CustomerValidationError('ghanaCardNo must match the Ghana Card format GHA-XXXXXXXXX-X');
  }
  return code;
}

/** customerType is validated separately by the caller (createCustomer rejects 'group'). */
function validateCustomerFields(customerType, fields) {
  const errors = [];
  if (!fields.fullName) errors.push('fullName is required');
  if (!fields.branchId) errors.push('branchId is required');

  if (customerType === 'individual') {
    if (!fields.ghanaCardNo) errors.push('ghanaCardNo is required for individual customers');
  } else if (customerType === 'sme') {
    if (!fields.businessRegistrationNo) errors.push('businessRegistrationNo is required for sme customers');
    if (!fields.contactPersonName) errors.push('contactPersonName is required for sme customers');
  } else {
    errors.push(`customer_type must be 'individual' or 'sme' (got '${customerType}'); use createGroup() for groups`);
  }

  if (errors.length > 0) {
    throw new CustomerValidationError(errors.join('; '));
  }
}

/**
 * Closure is NOT a "direct" transition — it only happens via
 * closeCustomerOnApproval(). This only governs active<->inactive.
 */
const DIRECT_STATUS_TRANSITIONS = {
  active: ['inactive'],
  inactive: ['active'],
  closed: [],
};

function isValidDirectStatusTransition(fromStatus, toStatus) {
  return Boolean(DIRECT_STATUS_TRANSITIONS[fromStatus] && DIRECT_STATUS_TRANSITIONS[fromStatus].includes(toStatus));
}

// --- Customer CRUD -----------------------------------------------------

async function getCustomer(pool, customerId) {
  const { rows } = await pool.query('SELECT * FROM customers WHERE id = $1', [customerId]);
  if (!rows[0]) throw new CustomerNotFoundError(`customer ${customerId} not found`);
  return rows[0];
}

async function listCustomers(pool, { branchId, customerType, status, classification } = {}) {
  const clauses = [];
  const params = [];
  const addFilter = (column, value) => {
    if (value === undefined || value === null) return;
    params.push(value);
    clauses.push(`${column} = $${params.length}`);
  };
  addFilter('branch_id', branchId);
  addFilter('customer_type', customerType);
  addFilter('status', status);
  addFilter('classification', classification);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await pool.query(`SELECT * FROM customers ${where} ORDER BY created_at DESC`, params);
  return rows;
}

/**
 * Surfaces any Ghana Card matches among CLOSED customers (fraud review),
 * without blocking on them — the DB only enforces uniqueness among
 * non-closed customers (customers_ghana_card_active_uq).
 */
async function findClosedGhanaCardMatches(db, ghanaCardNo) {
  if (!ghanaCardNo) return [];
  const { rows } = await db.query(
    "SELECT id, full_name, status, updated_at FROM customers WHERE ghana_card_no = $1 AND status = 'closed'",
    [ghanaCardNo]
  );
  return rows;
}

async function createCustomer(pool, params) {
  const { customerType, createdBy } = params;
  if (!createdBy) throw new CustomerValidationError('createdBy is required');
  validateCustomerFields(customerType, params);

  const ghanaCardNo = customerType === 'individual' ? validateGhanaCardNo(params.ghanaCardNo) : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (ghanaCardNo) {
      const { rows: activeMatch } = await client.query(
        "SELECT id FROM customers WHERE ghana_card_no = $1 AND status <> 'closed'",
        [ghanaCardNo]
      );
      if (activeMatch.length > 0) {
        throw new CustomerConflictError(`ghanaCardNo ${ghanaCardNo} is already registered to an active/inactive customer`);
      }
    }
    const priorClosedMatches = await findClosedGhanaCardMatches(client, ghanaCardNo);

    const { rows } = await client.query(
      `INSERT INTO customers
         (customer_type, branch_id, full_name, ghana_card_no, date_of_birth, gender,
          business_registration_no, contact_person_name, phone, email, address, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        customerType,
        params.branchId,
        params.fullName,
        ghanaCardNo,
        params.dateOfBirth || null,
        params.gender || null,
        params.businessRegistrationNo || null,
        params.contactPersonName || null,
        params.phone || null,
        params.email || null,
        params.address || null,
        createdBy,
      ]
    );
    const customer = rows[0];

    await auditLog.record(client, {
      userId: createdBy,
      branchId: customer.branch_id,
      action: 'customer.created',
      entityType: 'customer',
      entityId: customer.id,
      afterState: customer,
    });

    await client.query('COMMIT');
    return { ...customer, priorClosedMatches };
  } catch (err) {
    await client.query('ROLLBACK');
    // Backstop for the race a concurrent request could hit between the
    // pre-check above and this INSERT — customers_ghana_card_active_uq
    // (migration 015) is the real guarantee; this just gives it a clean
    // error shape instead of a raw Postgres 23505.
    if (err.code === '23505' && err.constraint === 'customers_ghana_card_active_uq') {
      throw new CustomerConflictError(`ghanaCardNo ${ghanaCardNo} is already registered to an active/inactive customer`);
    }
    throw err;
  } finally {
    client.release();
  }
}

const MUTABLE_CUSTOMER_FIELDS = {
  fullName: 'full_name',
  phone: 'phone',
  email: 'email',
  address: 'address',
  photoUrl: 'photo_url',
  fingerprintHash: 'fingerprint_hash',
  dateOfBirth: 'date_of_birth',
  gender: 'gender',
  contactPersonName: 'contact_person_name',
};

/** customer_type and ghana_card_no are identity fields — immutable after creation, like a branch's code. */
async function updateCustomer(pool, { customerId, updatedBy, fields }) {
  if (!updatedBy) throw new CustomerValidationError('updatedBy is required');
  if (fields.customerType !== undefined || fields.ghanaCardNo !== undefined) {
    throw new CustomerValidationError('customerType and ghanaCardNo cannot be changed after creation');
  }

  const before = await getCustomer(pool, customerId);

  const setClauses = [];
  const params = [];
  for (const [key, column] of Object.entries(MUTABLE_CUSTOMER_FIELDS)) {
    if (fields[key] !== undefined) {
      params.push(fields[key]);
      setClauses.push(`${column} = $${params.length}`);
    }
  }
  if (setClauses.length === 0) return before;

  params.push(customerId);
  const { rows } = await pool.query(
    `UPDATE customers SET ${setClauses.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`,
    params
  );
  const after = rows[0];

  await auditLog.record(pool, {
    userId: updatedBy,
    branchId: before.branch_id,
    action: 'customer.updated',
    entityType: 'customer',
    entityId: customerId,
    beforeState: before,
    afterState: after,
  });

  return after;
}

async function classifyCustomer(pool, { customerId, classification, classifiedBy }) {
  if (!classifiedBy) throw new CustomerValidationError('classifiedBy is required');
  const before = await getCustomer(pool, customerId);

  const { rows } = await pool.query(
    'UPDATE customers SET classification = $1, updated_at = now() WHERE id = $2 RETURNING *',
    [classification, customerId]
  );
  const after = rows[0];

  await auditLog.record(pool, {
    userId: classifiedBy,
    branchId: before.branch_id,
    action: 'customer.classified',
    entityType: 'customer',
    entityId: customerId,
    beforeState: { classification: before.classification },
    afterState: { classification: after.classification },
  });

  return after;
}

const KYC_STATUSES = ['pending', 'verified', 'rejected'];

/**
 * Sets a customer's KYC review outcome. Any of the three values may follow
 * any other (e.g. 'rejected' -> 'verified' after the customer resubmits
 * correct documents, or 'verified' -> 'rejected' if fraud is discovered
 * later) — there's no restrictive state machine here, just a permission
 * gate and an audit trail of every review decision.
 */
async function updateKycStatus(pool, { customerId, kycStatus, actorId, notes = null }) {
  if (!actorId) throw new CustomerValidationError('actorId is required');
  if (!KYC_STATUSES.includes(kycStatus)) {
    throw new CustomerValidationError(`kycStatus must be one of ${KYC_STATUSES.join(', ')}`);
  }

  const before = await getCustomer(pool, customerId);
  const { rows } = await pool.query(
    'UPDATE customers SET kyc_status = $1, updated_at = now() WHERE id = $2 RETURNING *',
    [kycStatus, customerId]
  );
  const after = rows[0];

  await auditLog.record(pool, {
    userId: actorId,
    branchId: before.branch_id,
    action: 'customer.kyc_status_changed',
    entityType: 'customer',
    entityId: customerId,
    beforeState: { kycStatus: before.kyc_status },
    afterState: { kycStatus: after.kyc_status, notes },
  });

  return after;
}

async function setCustomerActiveStatus(pool, { customerId, toStatus, actorId, reason = null }) {
  if (!actorId) throw new CustomerValidationError('actorId is required');
  const before = await getCustomer(pool, customerId);
  if (!isValidDirectStatusTransition(before.status, toStatus)) {
    throw new CustomerConflictError(`cannot transition customer ${customerId} from '${before.status}' to '${toStatus}'`);
  }

  const { rows } = await pool.query(
    'UPDATE customers SET status = $1, updated_at = now() WHERE id = $2 RETURNING *',
    [toStatus, customerId]
  );
  const after = rows[0];

  await auditLog.record(pool, {
    userId: actorId,
    branchId: before.branch_id,
    action: 'customer.status_changed',
    entityType: 'customer',
    entityId: customerId,
    beforeState: { status: before.status, reason },
    afterState: { status: after.status },
  });

  return after;
}

const deactivateCustomer = (pool, { customerId, actorId, reason }) =>
  setCustomerActiveStatus(pool, { customerId, toStatus: 'inactive', actorId, reason });

const reactivateCustomer = (pool, { customerId, actorId, reason }) =>
  setCustomerActiveStatus(pool, { customerId, toStatus: 'active', actorId, reason });

// --- Closure (maker-checker) ---------------------------------------------

/**
 * Requests closure. The "cooling-off/approval step before a closure is
 * final" from the module spec is satisfied by the maker-checker approval
 * itself (a different user must decide) — no separate timed cooling-off
 * period is implemented, since no specific duration is specified anywhere
 * in the spec and inventing one would be guessing a business rule. See
 * Decisions_Log.md Open Questions.
 */
async function requestClosure(pool, { customerId, reasonCode, requestedBy, reasonNotes = null }) {
  if (!reasonCode || !requestedBy) throw new CustomerValidationError('reasonCode and requestedBy are required');

  const customer = await getCustomer(pool, customerId);
  if (customer.status === 'closed') {
    throw new CustomerConflictError(`customer ${customerId} is already closed`);
  }

  const { rows: pendingRows } = await pool.query(
    `SELECT ac.id FROM account_closures ac
     JOIN approval_requests ar ON ar.id = ac.approval_request_id
     WHERE ac.customer_id = $1 AND ar.status = 'pending'`,
    [customerId]
  );
  if (pendingRows.length > 0) {
    throw new CustomerConflictError(`customer ${customerId} already has a pending closure request`);
  }

  const approvalRequest = await approvalWorkflow.requestApproval(pool, {
    actionType: 'customer.close',
    entityType: 'customer',
    entityId: customerId,
    branchId: customer.branch_id,
    requestedBy,
    payload: { reasonCode, reasonNotes },
  });

  const { rows } = await pool.query(
    `INSERT INTO account_closures (customer_id, approval_request_id, reason_code, reason_notes)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [customerId, approvalRequest.id, reasonCode, reasonNotes]
  );

  return { ...rows[0], approvalRequest };
}

async function getAccountClosure(pool, closureId) {
  const { rows } = await pool.query(
    `SELECT ac.*, ar.status AS approval_status, ar.requested_by, ar.decided_by, ar.decided_at
     FROM account_closures ac
     JOIN approval_requests ar ON ar.id = ac.approval_request_id
     WHERE ac.id = $1`,
    [closureId]
  );
  if (!rows[0]) throw new CustomerNotFoundError(`account_closure ${closureId} not found`);
  return rows[0];
}

/** Registered with approvalWorkflow as the execute handler for 'customer.close'. */
async function closeCustomerOnApproval(approvalRequest, db) {
  const customerId = Number(approvalRequest.entity_id);

  const { rows: closureRows } = await db.query(
    'SELECT * FROM account_closures WHERE approval_request_id = $1',
    [approvalRequest.id]
  );
  const closure = closureRows[0];
  if (!closure) throw new CustomerNotFoundError(`no account_closures row for approval_request ${approvalRequest.id}`);

  const { rows: beforeRows } = await db.query('SELECT * FROM customers WHERE id = $1 FOR UPDATE', [customerId]);
  const before = beforeRows[0];
  if (!before) throw new CustomerNotFoundError(`customer ${customerId} not found`);

  const { rows } = await db.query(
    `UPDATE customers SET status = 'closed', updated_at = now() WHERE id = $1 RETURNING *`,
    [customerId]
  );
  const after = rows[0];

  await db.query('UPDATE account_closures SET closure_date = current_date WHERE id = $1', [closure.id]);

  await auditLog.record(db, {
    userId: approvalRequest.decided_by,
    branchId: after.branch_id,
    action: 'customer.status_changed',
    entityType: 'customer',
    entityId: customerId,
    beforeState: before,
    afterState: after,
  });
}

/** Call once at app startup so decide() can dispatch customer closures. */
function registerCustomerExecutionHandlers() {
  approvalWorkflow.registerExecutionHandler('customer.close', closeCustomerOnApproval);
}

// --- Branch transfer -------------------------------------------------------

async function transferCustomerBranch(pool, { customerId, toBranchId, transferredBy, reason = null }) {
  if (!toBranchId || !transferredBy) throw new CustomerValidationError('toBranchId and transferredBy are required');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: beforeRows } = await client.query('SELECT * FROM customers WHERE id = $1 FOR UPDATE', [customerId]);
    const before = beforeRows[0];
    if (!before) throw new CustomerNotFoundError(`customer ${customerId} not found`);
    if (Number(before.branch_id) === Number(toBranchId)) {
      throw new CustomerValidationError(`customer ${customerId} is already at branch ${toBranchId}`);
    }

    const { rows: branchRows } = await client.query('SELECT * FROM branches WHERE id = $1', [toBranchId]);
    if (!branchRows[0]) throw new CustomerValidationError(`branch ${toBranchId} not found`);
    if (branchRows[0].status !== 'active') {
      throw new CustomerConflictError(`branch ${toBranchId} is not active (status: ${branchRows[0].status})`);
    }

    const { rows } = await client.query(
      'UPDATE customers SET branch_id = $1, updated_at = now() WHERE id = $2 RETURNING *',
      [toBranchId, customerId]
    );
    const after = rows[0];

    await client.query(
      `INSERT INTO customer_branch_transfers (customer_id, from_branch_id, to_branch_id, transferred_by, reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [customerId, before.branch_id, toBranchId, transferredBy, reason]
    );

    await auditLog.record(client, {
      userId: transferredBy,
      branchId: toBranchId,
      action: 'customer.branch_transferred',
      entityType: 'customer',
      entityId: customerId,
      beforeState: { branchId: before.branch_id },
      afterState: { branchId: after.branch_id },
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

// --- Documents / next-of-kin ----------------------------------------------

async function attachDocument(pool, { customerId, documentType, fileUrl, uploadedBy }) {
  if (!documentType || !fileUrl || !uploadedBy) {
    throw new CustomerValidationError('documentType, fileUrl, and uploadedBy are required');
  }
  const customer = await getCustomer(pool, customerId);
  const { rows } = await pool.query(
    `INSERT INTO customer_documents (customer_id, document_type, file_url, uploaded_by)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [customerId, documentType, fileUrl, uploadedBy]
  );
  await auditLog.record(pool, {
    userId: uploadedBy,
    branchId: customer.branch_id,
    action: 'customer.document_attached',
    entityType: 'customer_document',
    entityId: rows[0].id,
    afterState: rows[0],
  });
  return rows[0];
}

async function listDocuments(pool, { customerId }) {
  const { rows } = await pool.query('SELECT * FROM customer_documents WHERE customer_id = $1 ORDER BY created_at DESC', [
    customerId,
  ]);
  return rows;
}

async function addNextOfKin(pool, { customerId, fullName, relationship, phone, address, createdBy }) {
  if (!fullName || !createdBy) throw new CustomerValidationError('fullName and createdBy are required');
  const customer = await getCustomer(pool, customerId);
  const { rows } = await pool.query(
    `INSERT INTO next_of_kin (customer_id, full_name, relationship, phone, address, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [customerId, fullName, relationship || null, phone || null, address || null, createdBy]
  );
  await auditLog.record(pool, {
    userId: createdBy,
    branchId: customer.branch_id,
    action: 'customer.next_of_kin_added',
    entityType: 'next_of_kin',
    entityId: rows[0].id,
    afterState: rows[0],
  });
  return rows[0];
}

async function listNextOfKin(pool, { customerId }) {
  const { rows } = await pool.query('SELECT * FROM next_of_kin WHERE customer_id = $1 ORDER BY created_at DESC', [
    customerId,
  ]);
  return rows;
}

// --- Credit bureau (stub) ---------------------------------------------------

async function lookupCreditBureau(pool, { customerId, requestedBy }) {
  if (!requestedBy) throw new CustomerValidationError('requestedBy is required');
  const customer = await getCustomer(pool, customerId);
  if (customer.customer_type === 'group') {
    throw new CustomerValidationError('credit bureau lookups apply to individual/sme customers, not groups');
  }

  const requestPayload = {
    ghanaCardNo: customer.ghana_card_no,
    businessRegistrationNo: customer.business_registration_no,
    fullName: customer.full_name,
  };
  const responsePayload = creditBureauClient.lookup(requestPayload);

  const { rows } = await pool.query(
    `INSERT INTO credit_bureau_lookups (customer_id, requested_by, request_payload, response_payload)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [customerId, requestedBy, JSON.stringify(requestPayload), JSON.stringify(responsePayload)]
  );

  await auditLog.record(pool, {
    userId: requestedBy,
    branchId: customer.branch_id,
    action: 'customer.credit_bureau_lookup',
    entityType: 'customer',
    entityId: customerId,
    afterState: rows[0],
  });

  return rows[0];
}

async function listCreditBureauLookups(pool, { customerId }) {
  const { rows } = await pool.query(
    'SELECT * FROM credit_bureau_lookups WHERE customer_id = $1 ORDER BY requested_at DESC',
    [customerId]
  );
  return rows;
}

// --- Groups ------------------------------------------------------------

async function createGroup(pool, { name, branchId, formationDate = null, createdBy }) {
  if (!name || !branchId || !createdBy) throw new CustomerValidationError('name, branchId, and createdBy are required');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: customerRows } = await client.query(
      `INSERT INTO customers (customer_type, branch_id, full_name, created_by)
       VALUES ('group', $1, $2, $3) RETURNING *`,
      [branchId, name, createdBy]
    );
    const customer = customerRows[0];

    const { rows: groupRows } = await client.query(
      `INSERT INTO groups (customer_id, formation_date) VALUES ($1, $2) RETURNING *`,
      [customer.id, formationDate]
    );
    const group = groupRows[0];

    await auditLog.record(client, {
      userId: createdBy,
      branchId,
      action: 'group.created',
      entityType: 'group',
      entityId: group.id,
      afterState: { ...group, customer },
    });

    await client.query('COMMIT');
    return { ...group, customer };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getGroup(pool, groupId) {
  const { rows } = await pool.query(
    `SELECT g.*, c.full_name, c.branch_id, c.status AS customer_status
     FROM groups g JOIN customers c ON c.id = g.customer_id
     WHERE g.id = $1`,
    [groupId]
  );
  if (!rows[0]) throw new CustomerNotFoundError(`group ${groupId} not found`);
  return rows[0];
}

async function listGroupMembers(pool, { groupId, activeOnly = true }) {
  const where = activeOnly ? 'AND gm.left_at IS NULL' : '';
  const { rows } = await pool.query(
    `SELECT gm.*, c.full_name, c.kyc_status, c.status AS customer_status
     FROM group_members gm JOIN customers c ON c.id = gm.customer_id
     WHERE gm.group_id = $1 ${where}
     ORDER BY gm.joined_at`,
    [groupId]
  );
  return rows;
}

/** "Group members should be individually KYC'd" — enforced here: member's kyc_status must be 'verified'. */
async function addGroupMember(pool, { groupId, customerId, addedBy }) {
  if (!addedBy) throw new CustomerValidationError('addedBy is required');

  const group = await getGroup(pool, groupId);
  const member = await getCustomer(pool, customerId);

  if (member.customer_type !== 'individual') {
    throw new CustomerValidationError(`customer ${customerId} must be an individual to join a group`);
  }
  if (member.kyc_status !== 'verified') {
    throw new CustomerConflictError(`customer ${customerId} must be individually KYC-verified before joining a group`);
  }

  const { rows: existing } = await pool.query(
    'SELECT id FROM group_members WHERE group_id = $1 AND customer_id = $2 AND left_at IS NULL',
    [groupId, customerId]
  );
  if (existing.length > 0) {
    throw new CustomerConflictError(`customer ${customerId} is already an active member of group ${groupId}`);
  }

  const { rows } = await pool.query(
    `INSERT INTO group_members (group_id, customer_id, added_by) VALUES ($1, $2, $3) RETURNING *`,
    [groupId, customerId, addedBy]
  );

  await auditLog.record(pool, {
    userId: addedBy,
    branchId: group.branch_id,
    action: 'group.member_added',
    entityType: 'group',
    entityId: groupId,
    afterState: rows[0],
  });

  return rows[0];
}

async function removeGroupMember(pool, { groupId, customerId, removedBy }) {
  if (!removedBy) throw new CustomerValidationError('removedBy is required');
  const group = await getGroup(pool, groupId);

  const { rows } = await pool.query(
    `UPDATE group_members SET left_at = current_date
     WHERE group_id = $1 AND customer_id = $2 AND left_at IS NULL
     RETURNING *`,
    [groupId, customerId]
  );
  if (!rows[0]) throw new CustomerNotFoundError(`no active membership for customer ${customerId} in group ${groupId}`);

  // A departed member can't remain group leader.
  if (Number(group.group_leader_id) === Number(customerId)) {
    await pool.query('UPDATE groups SET group_leader_id = NULL, updated_at = now() WHERE id = $1', [groupId]);
  }

  await auditLog.record(pool, {
    userId: removedBy,
    branchId: group.branch_id,
    action: 'group.member_removed',
    entityType: 'group',
    entityId: groupId,
    afterState: rows[0],
  });

  return rows[0];
}

async function setGroupLeader(pool, { groupId, customerId, setBy }) {
  if (!setBy) throw new CustomerValidationError('setBy is required');
  const group = await getGroup(pool, groupId);

  const { rows: memberRows } = await pool.query(
    'SELECT id FROM group_members WHERE group_id = $1 AND customer_id = $2 AND left_at IS NULL',
    [groupId, customerId]
  );
  if (memberRows.length === 0) {
    throw new CustomerValidationError(`customer ${customerId} must be an active member of group ${groupId} before becoming leader`);
  }

  const { rows } = await pool.query(
    'UPDATE groups SET group_leader_id = $1, updated_at = now() WHERE id = $2 RETURNING *',
    [customerId, groupId]
  );

  await auditLog.record(pool, {
    userId: setBy,
    branchId: group.branch_id,
    action: 'group.leader_set',
    entityType: 'group',
    entityId: groupId,
    beforeState: { groupLeaderId: group.group_leader_id },
    afterState: { groupLeaderId: customerId },
  });

  return rows[0];
}

// --- Customer 360 --------------------------------------------------------

/**
 * Aggregates what's genuinely available today. Loans/savings/susu
 * participation and transaction history are listed under `pendingModules`
 * rather than faked, since Modules 3/4 don't exist yet — matches the same
 * honesty pattern Module 1's branch performance dashboard uses.
 */
async function getCustomer360(pool, { customerId }) {
  const customer = await getCustomer(pool, customerId);

  const [documents, nextOfKin, creditBureauLookups] = await Promise.all([
    listDocuments(pool, { customerId }),
    listNextOfKin(pool, { customerId }),
    listCreditBureauLookups(pool, { customerId }),
  ]);

  let groupInfo = null;
  if (customer.customer_type === 'group') {
    const { rows: groupRows } = await pool.query('SELECT * FROM groups WHERE customer_id = $1', [customerId]);
    if (groupRows[0]) {
      groupInfo = { group: groupRows[0], members: await listGroupMembers(pool, { groupId: groupRows[0].id }) };
    }
  } else {
    const { rows: membershipRows } = await pool.query(
      `SELECT g.id AS group_id, gc.full_name AS group_name, gm.joined_at
       FROM group_members gm
       JOIN groups g ON g.id = gm.group_id
       JOIN customers gc ON gc.id = g.customer_id
       WHERE gm.customer_id = $1 AND gm.left_at IS NULL`,
      [customerId]
    );
    groupInfo = { memberOfGroups: membershipRows };
  }

  return {
    customer,
    documents,
    nextOfKin,
    creditBureauLookups,
    groupInfo,
    pendingModules: ['loans (Module 3)', 'savings/susu (Module 4)', 'investments (Module 5)', 'transaction history'],
  };
}

module.exports = {
  createCustomer,
  getCustomer,
  listCustomers,
  updateCustomer,
  classifyCustomer,
  updateKycStatus,
  deactivateCustomer,
  reactivateCustomer,
  requestClosure,
  getAccountClosure,
  closeCustomerOnApproval,
  registerCustomerExecutionHandlers,
  transferCustomerBranch,
  attachDocument,
  listDocuments,
  addNextOfKin,
  listNextOfKin,
  lookupCreditBureau,
  listCreditBureauLookups,
  createGroup,
  getGroup,
  listGroupMembers,
  addGroupMember,
  removeGroupMember,
  setGroupLeader,
  getCustomer360,
  validateGhanaCardNo,
  validateCustomerFields,
  isValidDirectStatusTransition,
  CustomerValidationError,
  CustomerNotFoundError,
  CustomerConflictError,
};
