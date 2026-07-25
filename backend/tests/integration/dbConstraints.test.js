'use strict';

// Exercises the database-layer guarantees (migrations 004/005/007) directly
// against a real Postgres instance, since these are enforced by triggers
// and CHECK constraints that a mocked db can't verify. Requires
// TEST_DATABASE_URL to point at a disposable database — see backend/README.md.
//
// Run with: npm test -- tests/integration

require('dotenv').config();
const { Client } = require('pg');
const { execFileSync } = require('child_process');
const path = require('path');

const glPosting = require('../../src/shared/glPosting');
const approvalWorkflow = require('../../src/shared/approvalWorkflow');
const auditLog = require('../../src/shared/auditLog');

const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

describeIfDb('database-layer guarantees', () => {
  let client;
  let branchId;
  let makerId;
  let checkerId;
  let cashAccountId;
  let incomeAccountId;

  beforeAll(async () => {
    execFileSync('node', [path.join(__dirname, '../../src/db/migrate.js'), '--test'], {
      env: { ...process.env },
      stdio: 'inherit',
    });

    client = new Client({ connectionString });
    await client.connect();

    // Clean slate: financial tables are append-only in the app layer, but
    // the test db is disposable, so TRUNCATE ... CASCADE is fine here.
    await client.query(
      'TRUNCATE gl_journal_lines, gl_journal_entries, approval_requests, audit_log, users, gl_accounts RESTART IDENTITY CASCADE'
    );

    const { rows: branchRows } = await client.query("SELECT id FROM branches WHERE code = 'HQ'");
    branchId = branchRows[0].id;

    const { rows: roleRows } = await client.query("SELECT id FROM roles WHERE name = 'loan_officer'");
    const loanOfficerRoleId = roleRows[0].id;

    const { rows: userRows } = await client.query(
      `INSERT INTO users (full_name, email, password_hash, role_id, home_branch_id)
       VALUES ('Maker', 'maker@dbtest.local', 'x', $1, $2), ('Checker', 'checker@dbtest.local', 'x', $1, $2)
       RETURNING id`,
      [loanOfficerRoleId, branchId]
    );
    [makerId, checkerId] = userRows.map((r) => r.id);

    const { rows: acctRows } = await client.query(
      `INSERT INTO gl_accounts (code, name, account_type) VALUES ('1000', 'Cash in Hand', 'asset'), ('4000', 'Interest Income', 'income')
       RETURNING id`
    );
    [cashAccountId, incomeAccountId] = acctRows.map((r) => r.id);
  });

  afterAll(async () => {
    await client.end();
  });

  test('gl_journal_lines: an unbalanced entry is rejected at commit', async () => {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO gl_journal_entries (branch_id, reference, entry_date, source_module, created_by)
       VALUES ($1, 'IT-UNBAL', now()::date, 'manual_jv', $2) RETURNING id`,
      [branchId, makerId]
    );
    await client.query(
      'INSERT INTO gl_journal_lines (journal_entry_id, account_id, debit_pesewas, branch_id) VALUES ($1, $2, 10000, $3)',
      [rows[0].id, cashAccountId, branchId]
    );
    await client.query(
      'INSERT INTO gl_journal_lines (journal_entry_id, account_id, credit_pesewas, branch_id) VALUES ($1, $2, 9000, $3)',
      [rows[0].id, incomeAccountId, branchId]
    );
    await expect(client.query('COMMIT')).rejects.toThrow(/unbalanced/);
    await client.query('ROLLBACK').catch(() => {});
  });

  test('audit_log: rows cannot be updated or deleted once written', async () => {
    const row = await auditLog.record(client, {
      userId: makerId,
      branchId,
      action: 'test.action',
      entityType: 'test',
      entityId: '1',
    });
    await expect(client.query('UPDATE audit_log SET action = $1 WHERE id = $2', ['hacked', row.id])).rejects.toThrow(
      /immutable/
    );
    await expect(client.query('DELETE FROM audit_log WHERE id = $1', [row.id])).rejects.toThrow(/immutable/);
  });

  test('approval_requests: the database rejects decided_by === requested_by', async () => {
    await expect(
      client.query(
        `INSERT INTO approval_requests (action_type, entity_type, branch_id, requested_by, decided_by, status)
         VALUES ('loan.disburse', 'loan', $1, $2, $2, 'approved')`,
        [branchId, makerId]
      )
    ).rejects.toThrow(/maker_checker/);
  });

  test('glPosting.postJournalEntry posts a real balanced entry end to end', async () => {
    const pool = { connect: async () => ({ query: client.query.bind(client), release: () => {} }) };
    const result = await glPosting.postJournalEntry(pool, {
      branchId,
      reference: 'IT-BAL-1',
      entryDate: '2026-07-25',
      sourceModule: 'manual_jv',
      createdBy: makerId,
      lines: [
        { accountId: cashAccountId, debitPesewas: 50000 },
        { accountId: incomeAccountId, creditPesewas: 50000 },
      ],
    });

    expect(result.lines).toHaveLength(2);

    const balance = await glPosting.getAccountBalance(client, { accountId: cashAccountId });
    expect(balance).toBe(50000);
  });

  test('approvalWorkflow.decide end to end: maker cannot approve their own request, a different checker can', async () => {
    const request = await approvalWorkflow.requestApproval(client, {
      actionType: 'loan.disburse',
      entityType: 'loan',
      entityId: '1',
      branchId,
      requestedBy: makerId,
      amountPesewas: 100000,
    });

    await expect(
      approvalWorkflow.decide(client, { approvalId: request.id, decidedBy: makerId, decision: 'approved' })
    ).rejects.toThrow(approvalWorkflow.MakerCheckerViolationError);

    const decided = await approvalWorkflow.decide(client, {
      approvalId: request.id,
      decidedBy: checkerId,
      decision: 'approved',
    });
    expect(decided.status).toBe('approved');
    expect(decided.decided_by).toBe(checkerId);
  });
});
