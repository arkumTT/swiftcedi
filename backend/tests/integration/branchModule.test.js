'use strict';

// Exercises Module 1 (branchService.js) against a real Postgres instance —
// GL sub-account auto-generation, branch code immutability, the
// status-transition state machine, the reconciliation-gated maker-checker
// closure flow (dispatched through approvalWorkflow's execution-handler
// registry), staff assignment history, cross-branch grants, and
// cash-in-transit transfers. Requires TEST_DATABASE_URL — see backend/README.md.

require('dotenv').config();
const { Pool } = require('pg');
const { execFileSync } = require('child_process');
const path = require('path');

const branchService = require('../../src/modules/branch/branchService');
const approvalWorkflow = require('../../src/shared/approvalWorkflow');
const glPosting = require('../../src/shared/glPosting');

const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

describeIfDb('Module 1: branch management', () => {
  let pool;
  let loanOfficerRoleId;
  let branchManagerRoleId;
  let hqBranchId;

  beforeAll(async () => {
    execFileSync('node', [path.join(__dirname, '../../src/db/migrate.js'), '--test'], {
      env: { ...process.env },
      stdio: 'inherit',
    });

    pool = new Pool({ connectionString });

    // gl_journal_lines and audit_log are immutable at the DB layer (BEFORE
    // DELETE triggers) — TRUNCATE bypasses row-level triggers where plain
    // DELETE cannot, so those two (plus gl_journal_entries, truncated
    // together since gl_journal_lines FKs to it) need TRUNCATE. Everything
    // else uses targeted DELETEs rather than TRUNCATE ... CASCADE: cascading
    // from e.g. branch_regions would also wipe the HQ branch row and the
    // org-wide GL control accounts (both live in tables this suite depends
    // on already being seeded). TRUNCATE ... CASCADE on gl_journal_entries
    // also clears branch_transfers (which FKs to it), so that table is
    // omitted from the DELETE loop below.
    await pool.query('TRUNCATE gl_journal_lines, gl_journal_entries RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE audit_log RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE loan_repayments RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE savings_transactions, susu_collections RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE overdraft_interest_accruals RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE investment_accruals RESTART IDENTITY CASCADE');

    // Module 2 and 3 tables are cleared here too (in FK order, ending with
    // `customers` before `users`/`approval_requests`) since account_closures
    // and loan_restructures FK to approval_requests, and loans/loan_products
    // FK to customers/users — leaving that data behind would break this
    // suite's plain `DELETE FROM users` / `DELETE FROM approval_requests`
    // whenever another module's suite runs first in the same `npm test`.
    // loan_repayments needs TRUNCATE (DELETE is blocked by its immutability
    // trigger) and is handled above.
    for (const table of [
      'job_run_history',
      'scheduled_jobs',
      'archived_records',
      'archive_policies',
      'backup_runs',
      'subscription_licences',
      'reminder_notifications',
      'working_calendar',
      'aml_flags',
      'aml_rules',
      'sanctions_screening_results',
      'sanctions_list_entries',
      'regulatory_report_submissions',
      'regulatory_report_templates',
      'tax_rates',
      'regulatory_ratio_definitions',
      'loan_classifications',
      'loan_classification_configs',
      'agent_reconciliations',
      'agent_locations',
      'agent_assignments',
      'field_agents',
      'dashboard_widget_configs',
      'bank_accounts',
      'gl_prior_period_adjustments',
      'day_close_snapshots',
      'gl_periods',
      'transaction_reversals',
      'cash_back_requests',
      'cashier_tills',
      'investment_redemptions',
      'investment_payouts',
      'investments',
      'investment_products',
      'standing_order_runs',
      'standing_orders',
      'susu_commissions',
      'agent_remittances',
      'susu_accounts',
      'withdrawal_requests',
      'savings_accounts',
      'savings_products',
      'loan_group_liabilities',
      'loan_guarantors',
      'loan_collateral',
      'loan_restructures',
      'loan_concessions',
      'loan_schedules',
      'loans',
      'loan_products',
      'policy_rate_changes',
      'policy_rates',
      'account_closures',
      'credit_bureau_lookups',
      'customer_documents',
      'next_of_kin',
      'group_members',
      'groups',
      'customer_branch_transfers',
      'customers',
      'cross_branch_access_grants',
      'branch_staff_assignments',
      'branch_vault_configs',
      'approval_requests',
      'users',
    ]) {
      await pool.query(`DELETE FROM ${table}`);
    }
    // Scoped (not a blanket DELETE) so HQ's own branch_gl_accounts row
    // survives — nothing in any suite ever recreates it for HQ (it's
    // only ever created via branchService.createBranch(), which HQ
    // bypassed at seed time), so an unscoped delete here would leave HQ
    // permanently without one for the rest of this test run.
    await pool.query(
      "DELETE FROM branch_gl_accounts WHERE branch_id <> (SELECT id FROM branches WHERE code = 'HQ')"
    );
    // Scoped to exclude HQ for the same reason as the branch_gl_accounts
    // delete above — HQ's own sub-accounts (1000.HQ, 1010.HQ, ...) are
    // never recreated by any suite (only branchService.createBranch()
    // does that, and HQ bypassed it at seed time).
    await pool.query(
      "DELETE FROM gl_accounts WHERE branch_id IS NOT NULL AND branch_id <> (SELECT id FROM branches WHERE code = 'HQ')"
    );
    await pool.query("DELETE FROM branches WHERE code <> 'HQ'");
    await pool.query('DELETE FROM branch_clusters');
    await pool.query('DELETE FROM branch_regions');

    const { rows: hqRows } = await pool.query("SELECT id FROM branches WHERE code = 'HQ'");
    hqBranchId = hqRows[0].id;

    const { rows: roleRows } = await pool.query("SELECT id, name FROM roles WHERE name IN ('loan_officer', 'branch_manager')");
    loanOfficerRoleId = roleRows.find((r) => r.name === 'loan_officer').id;
    branchManagerRoleId = roleRows.find((r) => r.name === 'branch_manager').id;

    branchService.registerBranchExecutionHandlers();
  });

  afterAll(async () => {
    await pool.end();
  });

  async function createTestUser(email, roleId) {
    const { rows } = await pool.query(
      `INSERT INTO users (full_name, email, password_hash, role_id, home_branch_id)
       VALUES ($1, $2, 'x', $3, $4) RETURNING id`,
      [email, email, roleId, hqBranchId]
    );
    return rows[0].id;
  }

  async function fundCash(branchGlAccounts, branchId, amountPesewas, actorId) {
    const controls = await pool.query("SELECT id FROM gl_accounts WHERE code = '4000'");
    await glPosting.postJournalEntry(pool, {
      branchId,
      reference: `FUND-${branchId}-${Date.now()}`,
      entryDate: new Date().toISOString().slice(0, 10),
      sourceModule: 'manual_jv',
      createdBy: actorId,
      lines: [
        { accountId: branchGlAccounts.cash_in_hand_account_id, debitPesewas: amountPesewas, branchId },
        { accountId: controls.rows[0].id, creditPesewas: amountPesewas, branchId },
      ],
    });
  }

  test('createBranch auto-generates GL sub-accounts bound to the branch', async () => {
    const maker = await createTestUser('maker-create@test.local', loanOfficerRoleId);

    const branch = await branchService.createBranch(pool, { code: 'tst-01', name: 'Test Branch One', createdBy: maker });

    expect(branch.code).toBe('TST-01'); // uppercased
    expect(branch.glAccounts.cashInHand.code).toBe('1000.TST-01');
    expect(branch.glAccounts.cashInHand.branch_id).toBe(branch.id);
    expect(branch.glAccounts.vault.code).toBe('1010.TST-01');
    expect(branch.glAccounts.income.code).toBe('4000.TST-01');
    expect(branch.glAccounts.expense.code).toBe('5000.TST-01');

    const { rows } = await pool.query('SELECT * FROM branch_gl_accounts WHERE branch_id = $1', [branch.id]);
    expect(rows).toHaveLength(1);
    const { rows: vaultConfigRows } = await pool.query('SELECT * FROM branch_vault_configs WHERE branch_id = $1', [branch.id]);
    expect(vaultConfigRows).toHaveLength(1);
  });

  test('branch code becomes immutable once GL activity exists', async () => {
    const maker = await createTestUser('maker-immutable@test.local', loanOfficerRoleId);
    const branch = await branchService.createBranch(pool, { code: 'IMM-01', name: 'Immutable Test', createdBy: maker });
    const glAccounts = await pool.query('SELECT * FROM branch_gl_accounts WHERE branch_id = $1', [branch.id]);

    // No GL activity yet: code change should succeed.
    const renamed = await branchService.updateBranch(pool, {
      branchId: branch.id,
      updatedBy: maker,
      fields: { code: 'IMM-02' },
    });
    expect(renamed.code).toBe('IMM-02');

    await fundCash(glAccounts.rows[0], branch.id, 10000, maker);

    await expect(
      branchService.updateBranch(pool, { branchId: branch.id, updatedBy: maker, fields: { code: 'IMM-03' } })
    ).rejects.toThrow(branchService.BranchImmutableCodeError);
  });

  test('status transitions: active cannot jump directly to closed', async () => {
    const maker = await createTestUser('maker-transition@test.local', loanOfficerRoleId);
    const branch = await branchService.createBranch(pool, { code: 'TRN-01', name: 'Transition Test', createdBy: maker });

    await expect(
      branchService.changeBranchStatus(pool, { branchId: branch.id, toStatus: 'closed', requestedBy: maker })
    ).rejects.toThrow(branchService.InvalidStatusTransitionError);
  });

  test('closure is blocked with a clear reconciliation error when balances are non-zero, and never creates an approval request', async () => {
    const maker = await createTestUser('maker-reconcile@test.local', loanOfficerRoleId);
    const branch = await branchService.createBranch(pool, { code: 'REC-01', name: 'Reconcile Test', createdBy: maker });
    const glAccounts = await pool.query('SELECT * FROM branch_gl_accounts WHERE branch_id = $1', [branch.id]);
    await fundCash(glAccounts.rows[0], branch.id, 50000, maker);

    await branchService.changeBranchStatus(pool, { branchId: branch.id, toStatus: 'suspended', requestedBy: maker });

    const { rows: before } = await pool.query('SELECT COUNT(*) FROM approval_requests');

    await expect(
      branchService.changeBranchStatus(pool, { branchId: branch.id, toStatus: 'closed', requestedBy: maker })
    ).rejects.toThrow(branchService.BranchReconciliationError);

    const { rows: after } = await pool.query('SELECT COUNT(*) FROM approval_requests');
    expect(after[0].count).toBe(before[0].count); // no orphaned approval request was created
  });

  test('full closure flow: reconciled branch requests approval, maker cannot self-approve, a different checker closes it', async () => {
    const maker = await createTestUser('maker-close@test.local', loanOfficerRoleId);
    const checker = await createTestUser('checker-close@test.local', branchManagerRoleId);
    const branch = await branchService.createBranch(pool, { code: 'CLS-01', name: 'Closure Test', createdBy: maker });

    await branchService.changeBranchStatus(pool, { branchId: branch.id, toStatus: 'suspended', requestedBy: maker });

    const approvalRequest = await branchService.changeBranchStatus(pool, {
      branchId: branch.id,
      toStatus: 'closed',
      requestedBy: maker,
      reason: 'low volume',
    });
    expect(approvalRequest.status).toBe('pending');
    expect(approvalRequest.action_type).toBe('branch.close');

    // Maker-checker: the requester cannot decide their own closure.
    const client1 = await pool.connect();
    try {
      await client1.query('BEGIN');
      await expect(
        approvalWorkflow.decide(client1, { approvalId: approvalRequest.id, decidedBy: maker, decision: 'approved' })
      ).rejects.toThrow(approvalWorkflow.MakerCheckerViolationError);
    } finally {
      await client1.query('ROLLBACK');
      client1.release();
    }

    // A different user approves — dispatches to branchService.closeBranchOnApproval
    // via the registered execution handler, exactly as the generic HTTP
    // decide endpoint would.
    const client2 = await pool.connect();
    try {
      await client2.query('BEGIN');
      await approvalWorkflow.decide(client2, { approvalId: approvalRequest.id, decidedBy: checker, decision: 'approved' });
      await client2.query('COMMIT');
    } catch (err) {
      await client2.query('ROLLBACK');
      throw err;
    } finally {
      client2.release();
    }

    const closedBranch = await branchService.getBranch(pool, branch.id);
    expect(closedBranch.status).toBe('closed');
  });

  test('staff assignment keeps a history and updates users.home_branch_id', async () => {
    const admin = await createTestUser('admin-staff@test.local', branchManagerRoleId);
    const staffer = await createTestUser('staffer@test.local', loanOfficerRoleId);
    const branchA = await branchService.createBranch(pool, { code: 'STA-01', name: 'Staff A', createdBy: admin });
    const branchB = await branchService.createBranch(pool, { code: 'STA-02', name: 'Staff B', createdBy: admin });

    const first = await branchService.assignStaff(pool, { branchId: branchA.id, userId: staffer, assignedBy: admin });
    expect(first.user.home_branch_id).toBe(branchA.id);

    const second = await branchService.assignStaff(pool, { branchId: branchB.id, userId: staffer, assignedBy: admin });
    expect(second.user.home_branch_id).toBe(branchB.id);

    const history = await branchService.listStaffAssignments(pool, { userId: staffer });
    expect(history).toHaveLength(2);
    const closedAssignment = history.find((a) => a.branch_id === branchA.id);
    expect(closedAssignment.end_date).not.toBeNull();
    const openAssignment = history.find((a) => a.branch_id === branchB.id);
    expect(openAssignment.end_date).toBeNull();
  });

  test('cross-branch access grants: active while in range, inactive after revoke', async () => {
    const admin = await createTestUser('admin-grant@test.local', branchManagerRoleId);
    const staffer = await createTestUser('staffer-grant@test.local', loanOfficerRoleId);
    const branch = await branchService.createBranch(pool, { code: 'GRT-01', name: 'Grant Test', createdBy: admin });

    const grant = await branchService.grantCrossBranchAccess(pool, {
      branchId: branch.id,
      userId: staffer,
      startDate: '2020-01-01',
      endDate: '2099-01-01',
      grantedBy: admin,
    });

    let active = await branchService.listActiveCrossBranchGrants(pool, { userId: staffer });
    expect(active.map((g) => g.id)).toContain(grant.id);

    await branchService.revokeCrossBranchAccess(pool, { grantId: grant.id, revokedBy: admin });

    active = await branchService.listActiveCrossBranchGrants(pool, { userId: staffer });
    expect(active.map((g) => g.id)).not.toContain(grant.id);
  });

  test('cash-in-transit transfer: initiate blocked below balance, then full initiate/confirm cycle moves cash correctly', async () => {
    const admin = await createTestUser('admin-transfer@test.local', branchManagerRoleId);
    const source = await branchService.createBranch(pool, { code: 'TRF-01', name: 'Transfer Source', createdBy: admin });
    const destination = await branchService.createBranch(pool, { code: 'TRF-02', name: 'Transfer Dest', createdBy: admin });

    await expect(
      branchService.initiateTransfer(pool, {
        sourceBranchId: source.id,
        destinationBranchId: destination.id,
        amountPesewas: 10000,
        initiatedBy: admin,
      })
    ).rejects.toThrow(branchService.BranchValidationError);

    const sourceGlAccounts = await pool.query('SELECT * FROM branch_gl_accounts WHERE branch_id = $1', [source.id]);
    await fundCash(sourceGlAccounts.rows[0], source.id, 100000, admin);

    const transfer = await branchService.initiateTransfer(pool, {
      sourceBranchId: source.id,
      destinationBranchId: destination.id,
      amountPesewas: 40000,
      initiatedBy: admin,
    });
    expect(transfer.status).toBe('in_transit');

    const sourcePerfAfterInitiate = await branchService.getBranchPerformance(pool, { branchId: source.id });
    expect(sourcePerfAfterInitiate.cashInHandPesewas).toBe(60000);

    const confirmed = await branchService.confirmTransfer(pool, { transferId: transfer.id, confirmedBy: admin });
    expect(confirmed.status).toBe('completed');

    const destPerf = await branchService.getBranchPerformance(pool, { branchId: destination.id });
    expect(destPerf.cashInHandPesewas).toBe(40000);
  });

  test('cash-in-transit transfer: cancelling an in-transit transfer restores the source balance', async () => {
    const admin = await createTestUser('admin-cancel@test.local', branchManagerRoleId);
    const source = await branchService.createBranch(pool, { code: 'CAN-01', name: 'Cancel Source', createdBy: admin });
    const destination = await branchService.createBranch(pool, { code: 'CAN-02', name: 'Cancel Dest', createdBy: admin });
    const sourceGlAccounts = await pool.query('SELECT * FROM branch_gl_accounts WHERE branch_id = $1', [source.id]);
    await fundCash(sourceGlAccounts.rows[0], source.id, 100000, admin);

    const transfer = await branchService.initiateTransfer(pool, {
      sourceBranchId: source.id,
      destinationBranchId: destination.id,
      amountPesewas: 25000,
      initiatedBy: admin,
    });

    const cancelled = await branchService.cancelTransfer(pool, { transferId: transfer.id, cancelledBy: admin, reason: 'wrong amount' });
    expect(cancelled.status).toBe('cancelled');

    const sourcePerf = await branchService.getBranchPerformance(pool, { branchId: source.id });
    expect(sourcePerf.cashInHandPesewas).toBe(100000); // fully restored
  });
});
