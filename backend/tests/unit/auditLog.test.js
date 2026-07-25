'use strict';

const { record, query, AuditLogValidationError } = require('../../src/shared/auditLog');

function makeMockDb(rows) {
  return { query: jest.fn().mockResolvedValue({ rows }) };
}

describe('auditLog.record', () => {
  test('throws AuditLogValidationError when required fields are missing, without touching the db', async () => {
    const db = makeMockDb([]);
    await expect(record(db, { action: 'x' })).rejects.toThrow(AuditLogValidationError);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('inserts a row with before/after state serialized as JSON', async () => {
    const inserted = { id: 1 };
    const db = makeMockDb([inserted]);

    const result = await record(db, {
      userId: 5,
      branchId: 1,
      action: 'loan.disburse',
      entityType: 'loan',
      entityId: 42,
      beforeState: { status: 'pending' },
      afterState: { status: 'disbursed' },
    });

    expect(result).toBe(inserted);
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO audit_log/);
    expect(params).toEqual([
      5,
      1,
      'loan.disburse',
      'loan',
      '42',
      JSON.stringify({ status: 'pending' }),
      JSON.stringify({ status: 'disbursed' }),
      null,
    ]);
  });

  test('allows userId to be null for system-initiated actions', async () => {
    const db = makeMockDb([{ id: 2 }]);
    await record(db, { branchId: 1, action: 'job.run', entityType: 'scheduled_job', entityId: 'accrual' });
    const [, params] = db.query.mock.calls[0];
    expect(params[0]).toBeNull();
  });

  test('coerces a numeric entityId to a string', async () => {
    const db = makeMockDb([{ id: 3 }]);
    await record(db, { branchId: 1, action: 'x', entityType: 'loan', entityId: 42 });
    const [, params] = db.query.mock.calls[0];
    expect(params[4]).toBe('42');
  });
});

describe('auditLog.query', () => {
  test('builds a parameterized WHERE clause from the given filters only', async () => {
    const db = makeMockDb([]);
    await query(db, { branchId: 1, entityType: 'loan' }, { limit: 10, offset: 0 });

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/branch_id = \$1/);
    expect(sql).toMatch(/entity_type = \$2/);
    expect(sql).not.toMatch(/user_id/);
    expect(params).toEqual([1, 'loan', 10, 0]);
  });

  test('defaults to limit 50 / offset 0 and caps limit at 500', async () => {
    const db = makeMockDb([]);
    await query(db, {}, { limit: 10000 });
    const [, params] = db.query.mock.calls[0];
    expect(params).toEqual([500, 0]);
  });
});
