'use strict';

// Exercises Module 10 (agentService.js) against a real Postgres instance:
// field agent CRUD, reassignment history (one open assignment at a time),
// location pings (minimum-interval rejection + retention purge), and the
// end-of-day reconciliation lifecycle (matched vs pending_review vs
// resolved) tied back to real Module 4 susu_collections/agent_remittances
// data via the field_agents.user_id bridge. Requires TEST_DATABASE_URL —
// see backend/README.md.

require('dotenv').config();
const { Pool } = require('pg');
const { execFileSync } = require('child_process');
const path = require('path');

const agentService = require('../../src/modules/agent/agentService');
const branchService = require('../../src/modules/branch/branchService');
const customerService = require('../../src/modules/customer/customerService');
const susuService = require('../../src/modules/savings/susuService');

const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

describeIfDb('Module 10: agent & field operations', () => {
  let pool;
  let branchId;
  let otherBranchId;
  let ownerRoleId;
  let fieldAgentRoleId;
  let maker;

  beforeAll(async () => {
    execFileSync('node', [path.join(__dirname, '../../src/db/migrate.js'), '--test'], {
      env: { ...process.env },
      stdio: 'inherit',
    });

    pool = new Pool({ connectionString });

    await pool.query('DELETE FROM dashboard_widget_configs');
    await pool.query('DELETE FROM bank_statement_lines');
    await pool.query('DELETE FROM bank_accounts');
    await pool.query('DELETE FROM gl_manual_entries');
    await pool.query('DELETE FROM agent_reconciliations');
    await pool.query('DELETE FROM agent_locations');
    await pool.query('DELETE FROM agent_assignments');
    await pool.query('DELETE FROM field_agents');
    await pool.query('DELETE FROM aml_flags');
    await pool.query('DELETE FROM aml_rules');
    await pool.query('DELETE FROM sanctions_screening_results');
    await pool.query('DELETE FROM sanctions_list_entries');
    await pool.query('DELETE FROM regulatory_report_submissions');
    await pool.query('DELETE FROM regulatory_report_templates');
    await pool.query('DELETE FROM tax_rates');
    await pool.query('DELETE FROM regulatory_ratio_definitions');
    await pool.query('DELETE FROM loan_classifications');
    await pool.query('DELETE FROM loan_classification_configs');
    await pool.query('DELETE FROM job_run_history');
    await pool.query('DELETE FROM scheduled_jobs');
    await pool.query('DELETE FROM archived_records');
    await pool.query('DELETE FROM archive_policies');
    await pool.query('DELETE FROM backup_runs');
    await pool.query('DELETE FROM subscription_licences');
    await pool.query('DELETE FROM reminder_notifications');
    await pool.query('DELETE FROM working_calendar');
    await pool.query('TRUNCATE gl_journal_lines, gl_journal_entries RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE audit_log RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE loan_repayments RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE savings_transactions, susu_collections RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE overdraft_interest_accruals RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE investment_accruals RESTART IDENTITY CASCADE');
    for (const table of [
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
      'loan_schedules',
      'loans',
      'loan_products',
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
      'approval_thresholds',
      'users',
    ]) {
      await pool.query(`DELETE FROM ${table}`);
    }
    await pool.query(
      "DELETE FROM branch_gl_accounts WHERE branch_id <> (SELECT id FROM branches WHERE code = 'HQ')"
    );
    await pool.query(
      "DELETE FROM gl_accounts WHERE branch_id IS NOT NULL AND branch_id <> (SELECT id FROM branches WHERE code = 'HQ')"
    );
    await pool.query("DELETE FROM branches WHERE code <> 'HQ'");
    await pool.query('DELETE FROM branch_clusters');
    await pool.query('DELETE FROM branch_regions');

    branchService.registerBranchExecutionHandlers();
    customerService.registerCustomerExecutionHandlers();

    const { rows: ownerRows } = await pool.query("SELECT id FROM roles WHERE name = 'owner'");
    ownerRoleId = ownerRows[0].id;
    const { rows: fieldAgentRoleRows } = await pool.query("SELECT id FROM roles WHERE name = 'field_agent'");
    fieldAgentRoleId = fieldAgentRoleRows[0].id;

    maker = await createTestUser('agent-maker@test.local', ownerRoleId);

    const branch = await branchService.createBranch(pool, { code: 'AGT-01', name: 'Agent Test Branch', createdBy: maker });
    branchId = branch.id;
    const other = await branchService.createBranch(pool, { code: 'AGT-02', name: 'Agent Test Branch 2', createdBy: maker });
    otherBranchId = other.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  let userSeq = 0;
  async function createTestUser(email, roleId) {
    userSeq += 1;
    const { rows } = await pool.query(
      `INSERT INTO users (full_name, email, password_hash, role_id, home_branch_id)
       VALUES ($1, $1, 'x', $2, (SELECT id FROM branches WHERE code = 'HQ')) RETURNING id`,
      [email, roleId]
    );
    return rows[0].id;
  }

  async function createAgentUser() {
    return createTestUser(`field-agent-${userSeq + 1}@test.local`, fieldAgentRoleId);
  }

  let ghanaCardSeq = 0;
  async function createVerifiedCustomer(name) {
    ghanaCardSeq += 1;
    const customer = await customerService.createCustomer(pool, {
      customerType: 'individual',
      branchId,
      fullName: name,
      ghanaCardNo: `GHA-9200000${String(ghanaCardSeq).padStart(2, '0')}-1`,
      createdBy: maker,
    });
    await customerService.updateKycStatus(pool, { customerId: customer.id, kycStatus: 'verified', actorId: maker });
    return customer;
  }

  // --- Field agent CRUD ---------------------------------------------------

  test('createFieldAgent opens the first assignment, and a user cannot be registered twice', async () => {
    const userId = await createAgentUser();
    const agent = await agentService.createFieldAgent(pool, { userId, homeBranchId: branchId, territory: 'North Zone', createdBy: maker });
    expect(agent.status).toBe('active');
    expect(Number(agent.home_branch_id)).toBe(Number(branchId));

    const history = await agentService.listAssignmentHistory(pool, { agentId: agent.id });
    expect(history).toHaveLength(1);
    expect(history[0].end_date).toBeNull();

    await expect(
      agentService.createFieldAgent(pool, { userId, homeBranchId: branchId, createdBy: maker })
    ).rejects.toThrow(agentService.AgentConflictError);
  });

  test('updateFieldAgent rejects a direct homeBranchId change and accepts territory/status', async () => {
    const userId = await createAgentUser();
    const agent = await agentService.createFieldAgent(pool, { userId, homeBranchId: branchId, createdBy: maker });

    await expect(
      agentService.updateFieldAgent(pool, { agentId: agent.id, updatedBy: maker, fields: { homeBranchId: otherBranchId } })
    ).rejects.toThrow(agentService.AgentValidationError);

    const updated = await agentService.updateFieldAgent(pool, {
      agentId: agent.id,
      updatedBy: maker,
      fields: { territory: 'South Zone', status: 'inactive' },
    });
    expect(updated.territory).toBe('South Zone');
    expect(updated.status).toBe('inactive');
  });

  // --- Reassignment history -------------------------------------------------

  test('reassignAgent closes the current assignment and opens exactly one new one', async () => {
    const userId = await createAgentUser();
    const agent = await agentService.createFieldAgent(pool, { userId, homeBranchId: branchId, territory: 'Zone A', createdBy: maker });

    const reassigned = await agentService.reassignAgent(pool, {
      agentId: agent.id,
      newBranchId: otherBranchId,
      territory: 'Zone B',
      effectiveDate: '2027-02-01',
      reason: 'Branch coverage gap',
      assignedBy: maker,
    });
    expect(Number(reassigned.home_branch_id)).toBe(Number(otherBranchId));
    expect(reassigned.territory).toBe('Zone B');

    const history = await agentService.listAssignmentHistory(pool, { agentId: agent.id });
    expect(history).toHaveLength(2);
    const openRows = history.filter((h) => h.end_date === null);
    expect(openRows).toHaveLength(1);
    expect(Number(openRows[0].branch_id)).toBe(Number(otherBranchId));
    const closedRow = history.find((h) => h.end_date !== null);
    expect(closedRow.end_date.toISOString().slice(0, 10)).toBe('2027-02-01');
  });

  // --- Location tracking ---------------------------------------------------

  test('a location ping submitted too soon after the last one is rejected, and current/history reads work', async () => {
    const userId = await createAgentUser();
    const agent = await agentService.createFieldAgent(pool, { userId, homeBranchId: branchId, createdBy: maker });

    const first = await agentService.recordLocationPing(pool, {
      agentId: agent.id,
      gpsLat: 5.6,
      gpsLng: -0.19,
      recordedAt: '2026-03-01T08:00:00Z',
    });
    expect(first.agent_id).toBe(agent.id);

    await expect(
      agentService.recordLocationPing(pool, {
        agentId: agent.id,
        gpsLat: 5.61,
        gpsLng: -0.2,
        recordedAt: '2026-03-01T08:01:00Z',
      })
    ).rejects.toThrow(agentService.AgentPingTooFrequentError);

    const second = await agentService.recordLocationPing(pool, {
      agentId: agent.id,
      gpsLat: 5.61,
      gpsLng: -0.2,
      recordedAt: '2026-03-01T08:05:00Z',
    });

    const current = await agentService.getCurrentLocation(pool, { agentId: agent.id });
    expect(current.id).toBe(second.id);

    const history = await agentService.getLocationHistory(pool, { agentId: agent.id });
    expect(history).toHaveLength(2);

    await expect(
      agentService.recordLocationPing(pool, { agentId: agent.id, gpsLat: 999, gpsLng: 0, recordedAt: '2026-03-01T09:00:00Z' })
    ).rejects.toThrow(agentService.AgentValidationError);
  });

  test('purgeOldLocations deletes only pings older than the retention window', async () => {
    const userId = await createAgentUser();
    const agent = await agentService.createFieldAgent(pool, { userId, homeBranchId: branchId, createdBy: maker });

    await pool.query(
      `INSERT INTO agent_locations (agent_id, gps_lat, gps_lng, recorded_at) VALUES ($1, 5.6, -0.19, now() - interval '200 days')`,
      [agent.id]
    );
    await agentService.recordLocationPing(pool, { agentId: agent.id, gpsLat: 5.6, gpsLng: -0.19 });

    const result = await agentService.purgeOldLocations(pool, { olderThanDays: 90 });
    expect(result.deletedCount).toBeGreaterThanOrEqual(1);

    const remaining = await agentService.getLocationHistory(pool, { agentId: agent.id });
    expect(remaining.every((r) => new Date(r.recorded_at) > new Date(Date.now() - 90 * 86400000))).toBe(true);
  });

  // --- Reconciliation --------------------------------------------------------

  describe('reconciliation', () => {
    async function setupSusuAgentWithCollection(agentUserId, amountPesewas, collectionDate) {
      const customer = await createVerifiedCustomer('Susu Customer');
      const susuAccount = await susuService.createSusuAccount(pool, {
        customerId: customer.id,
        cycleLengthDays: 30,
        expectedCollectionPesewas: 1000,
        targetAmountPesewas: 30000,
        assignedAgentId: agentUserId,
        cycleStartDate: collectionDate,
        createdBy: maker,
      });
      return susuService.recordCollection(pool, {
        susuAccountId: susuAccount.id,
        agentId: agentUserId,
        amountPesewas,
        idempotencyKey: `agent-recon-${Date.now()}-${Math.random()}`,
        collectionDate,
      });
    }

    test('a fully-remitted day reconciles as matched', async () => {
      const userId = await createAgentUser();
      const agent = await agentService.createFieldAgent(pool, { userId, homeBranchId: branchId, createdBy: maker });
      await setupSusuAgentWithCollection(userId, 5000, '2026-04-01');

      await susuService.recordRemittance(pool, { agentId: userId, branchId, receivedBy: maker, remittedOn: '2026-04-01' });

      const reconciliation = await agentService.runDailyReconciliation(pool, { agentId: agent.id, date: '2026-04-01', createdBy: maker });
      expect(reconciliation.status).toBe('matched');
      expect(Number(reconciliation.expected_amount_pesewas)).toBe(5000);
      expect(Number(reconciliation.received_amount_pesewas)).toBe(5000);
      expect(Number(reconciliation.variance_pesewas)).toBe(0);
    });

    test('an agent still holding field cash overnight flags a pending-review variance, which never auto-resolves', async () => {
      const userId = await createAgentUser();
      const agent = await agentService.createFieldAgent(pool, { userId, homeBranchId: branchId, createdBy: maker });
      await setupSusuAgentWithCollection(userId, 7000, '2026-04-05');
      // Deliberately no remittance on 2026-04-05 — the agent is still holding the cash.

      const reconciliation = await agentService.runDailyReconciliation(pool, { agentId: agent.id, date: '2026-04-05', createdBy: maker });
      expect(reconciliation.status).toBe('pending_review');
      expect(Number(reconciliation.variance_pesewas)).toBe(7000);

      // Re-running the same day's reconciliation must not silently resolve it.
      const rerun = await agentService.runDailyReconciliation(pool, { agentId: agent.id, date: '2026-04-05', createdBy: maker });
      expect(rerun.status).toBe('pending_review');

      const resolved = await agentService.resolveReconciliation(pool, {
        reconciliationId: reconciliation.id,
        resolvedBy: maker,
        resolutionNotes: 'Agent remitted the next morning; confirmed with branch cashier.',
      });
      expect(resolved.status).toBe('resolved');
      expect(Number(resolved.reviewed_by)).toBe(Number(maker));

      // Re-running again after resolution must not revert it back to pending_review.
      const afterResolve = await agentService.runDailyReconciliation(pool, { agentId: agent.id, date: '2026-04-05', createdBy: maker });
      expect(afterResolve.status).toBe('resolved');
    });

    test('resolveReconciliation rejects a row that is not pending review, and requires resolutionNotes', async () => {
      const userId = await createAgentUser();
      const agent = await agentService.createFieldAgent(pool, { userId, homeBranchId: branchId, createdBy: maker });
      await setupSusuAgentWithCollection(userId, 1200, '2026-04-10');
      await susuService.recordRemittance(pool, { agentId: userId, branchId, receivedBy: maker, remittedOn: '2026-04-10' });
      const matched = await agentService.runDailyReconciliation(pool, { agentId: agent.id, date: '2026-04-10', createdBy: maker });
      expect(matched.status).toBe('matched');

      await expect(
        agentService.resolveReconciliation(pool, { reconciliationId: matched.id, resolvedBy: maker, resolutionNotes: 'n/a' })
      ).rejects.toThrow(agentService.AgentConflictError);

      await expect(
        agentService.resolveReconciliation(pool, { reconciliationId: matched.id, resolvedBy: maker })
      ).rejects.toThrow(agentService.AgentValidationError);
    });

    test('runBranchDailyReconciliation covers every active agent at the branch, and listReconciliations filters by branch/status', async () => {
      const userIdA = await createAgentUser();
      const agentA = await agentService.createFieldAgent(pool, { userId: userIdA, homeBranchId: branchId, createdBy: maker });
      const userIdB = await createAgentUser();
      const agentB = await agentService.createFieldAgent(pool, { userId: userIdB, homeBranchId: branchId, createdBy: maker });

      await setupSusuAgentWithCollection(userIdA, 2000, '2026-04-15');
      await susuService.recordRemittance(pool, { agentId: userIdA, branchId, receivedBy: maker, remittedOn: '2026-04-15' });
      await setupSusuAgentWithCollection(userIdB, 3000, '2026-04-15');
      // agentB doesn't remit -> pending_review

      const results = await agentService.runBranchDailyReconciliation(pool, { branchId, date: '2026-04-15', createdBy: maker });
      expect(results.length).toBeGreaterThanOrEqual(2);

      const branchList = await agentService.listReconciliations(pool, { branchId, fromDate: '2026-04-15', toDate: '2026-04-15' });
      const idsInBranch = branchList.map((r) => Number(r.agent_id));
      expect(idsInBranch).toContain(Number(agentA.id));
      expect(idsInBranch).toContain(Number(agentB.id));

      const pendingOnly = await agentService.listReconciliations(pool, {
        branchId,
        status: 'pending_review',
        fromDate: '2026-04-15',
        toDate: '2026-04-15',
      });
      expect(pendingOnly.some((r) => Number(r.agent_id) === Number(agentB.id))).toBe(true);
      expect(pendingOnly.some((r) => Number(r.agent_id) === Number(agentA.id))).toBe(false);
    });
  });
});
