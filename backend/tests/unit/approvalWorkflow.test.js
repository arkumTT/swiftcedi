'use strict';

const {
  isApprovalRequired,
  requestApproval,
  decide,
  listApprovals,
  registerExecutionHandler,
  registerRejectionHandler,
  ApprovalValidationError,
  ApprovalNotFoundError,
  MakerCheckerViolationError,
} = require('../../src/shared/approvalWorkflow');

function makeSequentialDb(responses) {
  let call = 0;
  return { query: jest.fn(() => Promise.resolve(responses[call++])) };
}

describe('isApprovalRequired (pure)', () => {
  test('not required when the action has no configured threshold', () => {
    expect(isApprovalRequired(null, 1_000_000)).toBe(false);
  });

  test('not required when amount is below the threshold', () => {
    expect(isApprovalRequired({ amount_threshold_pesewas: 500000 }, 100000)).toBe(false);
  });

  test('required once amount meets or exceeds the threshold', () => {
    expect(isApprovalRequired({ amount_threshold_pesewas: 500000 }, 500000)).toBe(true);
    expect(isApprovalRequired({ amount_threshold_pesewas: 500000 }, 900000)).toBe(true);
  });
});

describe('requestApproval', () => {
  test('validates required fields before querying the db', async () => {
    const db = { query: jest.fn() };
    await expect(requestApproval(db, { actionType: 'loan.disburse' })).rejects.toThrow(ApprovalValidationError);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('stamps required_approver_role_id from the applicable threshold and audit-logs the request', async () => {
    const threshold = { required_approver_role_id: 2, amount_threshold_pesewas: 100000 };
    const created = { id: 5, status: 'pending' };
    const db = makeSequentialDb([
      { rows: [threshold] }, // getApplicableThreshold
      { rows: [created] }, // INSERT approval_requests
      { rows: [{ id: 1 }] }, // audit log insert
    ]);

    const result = await requestApproval(db, {
      actionType: 'loan.disburse',
      entityType: 'loan',
      branchId: 1,
      requestedBy: 7,
      amountPesewas: 200000,
    });

    expect(result).toBe(created);
    expect(db.query).toHaveBeenCalledTimes(3);
    const insertParams = db.query.mock.calls[1][1];
    expect(insertParams).toContain(2); // required_approver_role_id passed through from threshold
  });

  test('stamps required_approver_role_ids (plural) from a multi-role threshold', async () => {
    const threshold = { required_approver_role_ids: [2, 4], amount_threshold_pesewas: 100000 };
    const created = { id: 5, status: 'pending' };
    const db = makeSequentialDb([
      { rows: [threshold] }, // getApplicableThreshold
      { rows: [created] }, // INSERT approval_requests
      { rows: [{ id: 1 }] }, // audit log insert
    ]);

    await requestApproval(db, {
      actionType: 'loan.approve',
      entityType: 'loan',
      branchId: 1,
      requestedBy: 7,
      amountPesewas: 20_000_000,
    });

    const insertParams = db.query.mock.calls[1][1];
    expect(insertParams).toContain(2); // required_approver_role_id backfilled as role_ids[0]
    expect(insertParams).toContainEqual([2, 4]); // required_approver_role_ids passed through
  });

  test('forwards amountPesewas into the threshold lookup query, for amount-tiered thresholds', async () => {
    const threshold = { required_approver_role_ids: [3], amount_threshold_pesewas: 10_000_000 };
    const created = { id: 6, status: 'pending' };
    const db = makeSequentialDb([
      { rows: [threshold] }, // getApplicableThreshold
      { rows: [created] }, // INSERT approval_requests
      { rows: [{ id: 1 }] }, // audit log insert
    ]);

    await requestApproval(db, {
      actionType: 'loan.approve',
      entityType: 'loan',
      branchId: 1,
      requestedBy: 7,
      amountPesewas: 20_000_000,
    });

    const thresholdLookupParams = db.query.mock.calls[0][1];
    expect(thresholdLookupParams).toEqual(['loan.approve', 1, 20_000_000]);
  });
});

describe('decide', () => {
  test('rejects an invalid decision value without querying the db', async () => {
    const db = { query: jest.fn() };
    await expect(decide(db, { approvalId: 1, decidedBy: 2, decision: 'maybe' })).rejects.toThrow(
      ApprovalValidationError
    );
    expect(db.query).not.toHaveBeenCalled();
  });

  test('rejects when the approval request does not exist', async () => {
    const db = makeSequentialDb([{ rows: [] }]);
    await expect(decide(db, { approvalId: 999, decidedBy: 2, decision: 'approved' })).rejects.toThrow(
      ApprovalNotFoundError
    );
  });

  test('rejects when the request is no longer pending', async () => {
    const existing = { id: 1, requested_by: 7, status: 'approved', required_approver_role_id: null };
    const db = makeSequentialDb([{ rows: [existing] }]);
    await expect(decide(db, { approvalId: 1, decidedBy: 2, decision: 'approved' })).rejects.toThrow(
      ApprovalValidationError
    );
  });

  test('maker-checker: the requester cannot decide their own request', async () => {
    const existing = {
      id: 1,
      requested_by: 7,
      status: 'pending',
      required_approver_role_id: null,
      action_type: 'loan.disburse',
      branch_id: 1,
    };
    const db = makeSequentialDb([{ rows: [existing] }]);
    await expect(decide(db, { approvalId: 1, decidedBy: 7, decision: 'approved' })).rejects.toThrow(
      MakerCheckerViolationError
    );
  });

  test('rejects when the decider does not hold the required approver role', async () => {
    const existing = {
      id: 1,
      requested_by: 7,
      status: 'pending',
      required_approver_role_id: 2,
      action_type: 'loan.disburse',
      branch_id: 1,
    };
    const db = makeSequentialDb([
      { rows: [existing] }, // SELECT ... FOR UPDATE
      { rows: [{ role_id: 3 }] }, // SELECT role_id FROM users (wrong role)
    ]);
    await expect(decide(db, { approvalId: 1, decidedBy: 2, decision: 'approved' })).rejects.toThrow(
      MakerCheckerViolationError
    );
  });

  test('multi-role: decider holding any one of the required roles may decide', async () => {
    const existing = {
      id: 1,
      requested_by: 7,
      status: 'pending',
      required_approver_role_id: 2,
      required_approver_role_ids: [2, 5],
      action_type: 'loan.approve',
      branch_id: 1,
    };
    const updated = { ...existing, status: 'approved', decided_by: 8 };
    const db = makeSequentialDb([
      { rows: [existing] }, // SELECT ... FOR UPDATE
      { rows: [{ role_id: 5 }] }, // SELECT role_id FROM users (second allowed role)
      { rows: [updated] }, // UPDATE ... RETURNING
      { rows: [{ id: 99 }] }, // audit log insert
    ]);

    const result = await decide(db, { approvalId: 1, decidedBy: 8, decision: 'approved' });
    expect(result).toBe(updated);
  });

  test('multi-role: decider holding none of the required roles is rejected', async () => {
    const existing = {
      id: 1,
      requested_by: 7,
      status: 'pending',
      required_approver_role_id: 2,
      required_approver_role_ids: [2, 5],
      action_type: 'loan.approve',
      branch_id: 1,
    };
    const db = makeSequentialDb([
      { rows: [existing] }, // SELECT ... FOR UPDATE
      { rows: [{ role_id: 9 }] }, // SELECT role_id FROM users (not in the required set)
    ]);

    await expect(decide(db, { approvalId: 1, decidedBy: 8, decision: 'approved' })).rejects.toThrow(
      MakerCheckerViolationError
    );
  });

  test('approves, invokes the execute callback, and records an audit log entry', async () => {
    const existing = {
      id: 1,
      requested_by: 7,
      status: 'pending',
      required_approver_role_id: null,
      action_type: 'loan.disburse',
      branch_id: 1,
    };
    const updated = { ...existing, status: 'approved', decided_by: 2 };
    const db = makeSequentialDb([
      { rows: [existing] }, // SELECT ... FOR UPDATE
      { rows: [updated] }, // UPDATE ... RETURNING
      { rows: [{ id: 99 }] }, // audit log insert
    ]);
    const execute = jest.fn().mockResolvedValue(undefined);

    const result = await decide(db, { approvalId: 1, decidedBy: 2, decision: 'approved', execute });

    expect(result).toBe(updated);
    expect(execute).toHaveBeenCalledWith(updated, db);
    expect(db.query).toHaveBeenCalledTimes(3);
  });

  test('rejecting a request does not invoke the execute callback', async () => {
    const existing = {
      id: 1,
      requested_by: 7,
      status: 'pending',
      required_approver_role_id: null,
      action_type: 'loan.disburse',
      branch_id: 1,
    };
    const updated = { ...existing, status: 'rejected', decided_by: 2 };
    const db = makeSequentialDb([{ rows: [existing] }, { rows: [updated] }, { rows: [{ id: 99 }] }]);
    const execute = jest.fn();

    await decide(db, { approvalId: 1, decidedBy: 2, decision: 'rejected', reason: 'insufficient collateral', execute });

    expect(execute).not.toHaveBeenCalled();
  });

  test('dispatches to a handler registered for the request action_type when no explicit execute is given', async () => {
    const existing = {
      id: 1,
      requested_by: 7,
      status: 'pending',
      required_approver_role_id: null,
      action_type: 'branch.close.test',
      branch_id: 1,
    };
    const updated = { ...existing, status: 'approved', decided_by: 2 };
    const db = makeSequentialDb([{ rows: [existing] }, { rows: [updated] }, { rows: [{ id: 99 }] }]);
    const handler = jest.fn().mockResolvedValue(undefined);
    registerExecutionHandler('branch.close.test', handler);

    await decide(db, { approvalId: 1, decidedBy: 2, decision: 'approved' });

    expect(handler).toHaveBeenCalledWith(updated, db);
  });

  test('dispatches to a registered REJECTION handler on rejection, never on approval', async () => {
    const existing = {
      id: 1,
      requested_by: 7,
      status: 'pending',
      required_approver_role_id: null,
      action_type: 'loan.approve.test',
      branch_id: 1,
    };
    const updated = { ...existing, status: 'rejected', decided_by: 2 };
    const db = makeSequentialDb([{ rows: [existing] }, { rows: [updated] }, { rows: [{ id: 99 }] }]);
    const onReject = jest.fn().mockResolvedValue(undefined);
    registerRejectionHandler('loan.approve.test', onReject);

    await decide(db, { approvalId: 1, decidedBy: 2, decision: 'rejected' });

    expect(onReject).toHaveBeenCalledWith(updated, db);
  });

  test('a registered rejection handler is never invoked on approval', async () => {
    const existing = {
      id: 1,
      requested_by: 7,
      status: 'pending',
      required_approver_role_id: null,
      action_type: 'loan.approve.test2',
      branch_id: 1,
    };
    const updated = { ...existing, status: 'approved', decided_by: 2 };
    const db = makeSequentialDb([{ rows: [existing] }, { rows: [updated] }, { rows: [{ id: 99 }] }]);
    const onReject = jest.fn();
    registerRejectionHandler('loan.approve.test2', onReject);

    await decide(db, { approvalId: 1, decidedBy: 2, decision: 'approved' });

    expect(onReject).not.toHaveBeenCalled();
  });

  test('an explicit execute callback takes precedence over a registered handler', async () => {
    const existing = {
      id: 1,
      requested_by: 7,
      status: 'pending',
      required_approver_role_id: null,
      action_type: 'branch.close.test2',
      branch_id: 1,
    };
    const updated = { ...existing, status: 'approved', decided_by: 2 };
    const db = makeSequentialDb([{ rows: [existing] }, { rows: [updated] }, { rows: [{ id: 99 }] }]);
    const registeredHandler = jest.fn();
    const explicitExecute = jest.fn().mockResolvedValue(undefined);
    registerExecutionHandler('branch.close.test2', registeredHandler);

    await decide(db, { approvalId: 1, decidedBy: 2, decision: 'approved', execute: explicitExecute });

    expect(explicitExecute).toHaveBeenCalledWith(updated, db);
    expect(registeredHandler).not.toHaveBeenCalled();
  });
});

describe('listApprovals', () => {
  test('queries with no filters when none are given', async () => {
    const rows = [{ id: 1 }, { id: 2 }];
    const db = makeSequentialDb([{ rows }]);
    const result = await listApprovals(db, {});
    expect(result).toBe(rows);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).not.toMatch(/WHERE/);
    expect(params).toEqual([]);
  });

  test('builds a parameterized WHERE clause from provided filters', async () => {
    const db = makeSequentialDb([{ rows: [] }]);
    await listApprovals(db, { status: 'pending', actionType: 'loan.disburse', entityType: 'loan', branchId: 3 });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/status = \$1/);
    expect(sql).toMatch(/action_type = \$2/);
    expect(sql).toMatch(/entity_type = \$3/);
    expect(sql).toMatch(/branch_id = \$4/);
    expect(params).toEqual(['pending', 'loan.disburse', 'loan', 3]);
  });
});
