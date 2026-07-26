'use strict';

// Exercises Module 2 (customerService.js) against a real Postgres instance:
// Ghana Card uniqueness (active-only, with closed-customer re-registration
// allowed), type-aware onboarding, KYC-gated group membership, the
// reconciliation-free but still maker-checker-gated closure flow (dispatched
// through approvalWorkflow's execution-handler registry, same pattern as
// Module 1), and branch transfer history. Requires TEST_DATABASE_URL — see
// backend/README.md.

require('dotenv').config();
const { Pool } = require('pg');
const { execFileSync } = require('child_process');
const path = require('path');

const customerService = require('../../src/modules/customer/customerService');
const branchService = require('../../src/modules/branch/branchService');
const approvalWorkflow = require('../../src/shared/approvalWorkflow');

const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

describeIfDb('Module 2: customer & CRM', () => {
  let pool;
  let branchAId;
  let branchBId;
  let ownerRoleId;

  beforeAll(async () => {
    execFileSync('node', [path.join(__dirname, '../../src/db/migrate.js'), '--test'], {
      env: { ...process.env },
      stdio: 'inherit',
    });

    pool = new Pool({ connectionString });

    // Same targeted-delete approach as branchModule.test.js — see its
    // comment for why TRUNCATE ... CASCADE on branch_regions/branches/
    // gl_accounts is unsafe here (would wipe the HQ branch and GL control
    // accounts other test files depend on).
    await pool.query('TRUNCATE gl_journal_lines, gl_journal_entries RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE audit_log RESTART IDENTITY CASCADE');
    // loan_repayments needs TRUNCATE — plain DELETE is blocked by its
    // immutability trigger. Module 3's tables are cleared here (FK order:
    // loans before customers/users) because loans FK to customers.
    await pool.query('TRUNCATE loan_repayments RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE savings_transactions, susu_collections RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE overdraft_interest_accruals RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE investment_accruals RESTART IDENTITY CASCADE');
    for (const table of [
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

    branchService.registerBranchExecutionHandlers();
    customerService.registerCustomerExecutionHandlers();

    const { rows: roleRows } = await pool.query("SELECT id FROM roles WHERE name = 'owner'");
    ownerRoleId = roleRows[0].id;

    const admin = await createTestUser('admin-setup@test.local');
    const branchA = await branchService.createBranch(pool, { code: 'CUS-A', name: 'Customer Test A', createdBy: admin });
    const branchB = await branchService.createBranch(pool, { code: 'CUS-B', name: 'Customer Test B', createdBy: admin });
    branchAId = branchA.id;
    branchBId = branchB.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  async function createTestUser(email) {
    const { rows } = await pool.query(
      `INSERT INTO users (full_name, email, password_hash, role_id, home_branch_id)
       VALUES ($1, $1, 'x', $2, (SELECT id FROM branches WHERE code = 'HQ'))
       RETURNING id`,
      [email, ownerRoleId]
    );
    return rows[0].id;
  }

  test('createCustomer: individual requires a valid, unique Ghana Card', async () => {
    const actor = await createTestUser('maker-onboard@test.local');

    const customer = await customerService.createCustomer(pool, {
      customerType: 'individual',
      branchId: branchAId,
      fullName: 'Ama Mensah',
      ghanaCardNo: 'gha-111111111-1',
      createdBy: actor,
    });
    expect(customer.ghana_card_no).toBe('GHA-111111111-1'); // normalized
    expect(customer.kyc_status).toBe('pending');
    expect(customer.priorClosedMatches).toEqual([]);

    await expect(
      customerService.createCustomer(pool, {
        customerType: 'individual',
        branchId: branchAId,
        fullName: 'Impostor',
        ghanaCardNo: 'GHA-111111111-1',
        createdBy: actor,
      })
    ).rejects.toThrow(customerService.CustomerConflictError);
  });

  test('Ghana Card can be re-registered after the original customer is closed (fraud review, not a block)', async () => {
    const actor = await createTestUser('maker-reregister@test.local');
    const checker = await createTestUser('checker-reregister@test.local');

    const first = await customerService.createCustomer(pool, {
      customerType: 'individual',
      branchId: branchAId,
      fullName: 'First Registrant',
      ghanaCardNo: 'GHA-222222222-2',
      createdBy: actor,
    });

    const closure = await customerService.requestClosure(pool, {
      customerId: first.id,
      reasonCode: 'duplicate',
      requestedBy: actor,
    });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await approvalWorkflow.decide(client, {
        approvalId: closure.approvalRequest.id,
        decidedBy: checker,
        decision: 'approved',
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const closedCustomer = await customerService.getCustomer(pool, first.id);
    expect(closedCustomer.status).toBe('closed');

    const second = await customerService.createCustomer(pool, {
      customerType: 'individual',
      branchId: branchAId,
      fullName: 'Second Registrant (re-registration)',
      ghanaCardNo: 'GHA-222222222-2',
      createdBy: actor,
    });
    expect(second.id).not.toBe(first.id);
    expect(second.priorClosedMatches.map((m) => m.id)).toContain(first.id);
  });

  test('SME onboarding requires businessRegistrationNo and contactPersonName', async () => {
    const actor = await createTestUser('maker-sme@test.local');
    await expect(
      customerService.createCustomer(pool, {
        customerType: 'sme',
        branchId: branchAId,
        fullName: 'Missing Fields Ltd',
        createdBy: actor,
      })
    ).rejects.toThrow(customerService.CustomerValidationError);

    const sme = await customerService.createCustomer(pool, {
      customerType: 'sme',
      branchId: branchAId,
      fullName: 'Kojo Traders Ltd',
      businessRegistrationNo: 'BN-999',
      contactPersonName: 'Kojo Owusu',
      createdBy: actor,
    });
    expect(sme.customer_type).toBe('sme');
  });

  test('group membership requires the member be individually KYC-verified first', async () => {
    const actor = await createTestUser('maker-group@test.local');
    const member = await customerService.createCustomer(pool, {
      customerType: 'individual',
      branchId: branchAId,
      fullName: 'Group Member One',
      ghanaCardNo: 'GHA-333333333-3',
      createdBy: actor,
    });
    const group = await customerService.createGroup(pool, { name: 'Susu Group A', branchId: branchAId, createdBy: actor });

    await expect(
      customerService.addGroupMember(pool, { groupId: group.id, customerId: member.id, addedBy: actor })
    ).rejects.toThrow(customerService.CustomerConflictError);

    await customerService.updateKycStatus(pool, { customerId: member.id, kycStatus: 'verified', actorId: actor });

    const membership = await customerService.addGroupMember(pool, { groupId: group.id, customerId: member.id, addedBy: actor });
    expect(membership.customer_id).toBe(member.id);

    await customerService.setGroupLeader(pool, { groupId: group.id, customerId: member.id, setBy: actor });
    let refreshedGroup = await customerService.getGroup(pool, group.id);
    expect(refreshedGroup.group_leader_id).toBe(member.id);

    // Removing the leader clears group_leader_id.
    await customerService.removeGroupMember(pool, { groupId: group.id, customerId: member.id, removedBy: actor });
    refreshedGroup = await customerService.getGroup(pool, group.id);
    expect(refreshedGroup.group_leader_id).toBeNull();

    const activeMembers = await customerService.listGroupMembers(pool, { groupId: group.id });
    expect(activeMembers).toHaveLength(0);
  });

  test('closure: maker cannot self-approve, a different checker closes the customer, closure_date is stamped', async () => {
    const maker = await createTestUser('maker-close@test.local');
    const checker = await createTestUser('checker-close@test.local');
    const customer = await customerService.createCustomer(pool, {
      customerType: 'individual',
      branchId: branchAId,
      fullName: 'Closure Target',
      ghanaCardNo: 'GHA-444444444-4',
      createdBy: maker,
    });

    const closure = await customerService.requestClosure(pool, {
      customerId: customer.id,
      reasonCode: 'customer_request',
      requestedBy: maker,
    });
    expect(closure.approvalRequest.status).toBe('pending');

    const client1 = await pool.connect();
    try {
      await client1.query('BEGIN');
      await expect(
        approvalWorkflow.decide(client1, { approvalId: closure.approvalRequest.id, decidedBy: maker, decision: 'approved' })
      ).rejects.toThrow(approvalWorkflow.MakerCheckerViolationError);
    } finally {
      await client1.query('ROLLBACK');
      client1.release();
    }

    const client2 = await pool.connect();
    try {
      await client2.query('BEGIN');
      await approvalWorkflow.decide(client2, { approvalId: closure.approvalRequest.id, decidedBy: checker, decision: 'approved' });
      await client2.query('COMMIT');
    } catch (err) {
      await client2.query('ROLLBACK');
      throw err;
    } finally {
      client2.release();
    }

    const closedCustomer = await customerService.getCustomer(pool, customer.id);
    expect(closedCustomer.status).toBe('closed');

    const closureDetail = await customerService.getAccountClosure(pool, closure.id);
    expect(closureDetail.approval_status).toBe('approved');
    expect(closureDetail.closure_date).not.toBeNull();

    // Cannot request a second closure for an already-closed customer.
    await expect(
      customerService.requestClosure(pool, { customerId: customer.id, reasonCode: 'x', requestedBy: maker })
    ).rejects.toThrow(customerService.CustomerConflictError);
  });

  test('a customer cannot have two pending closure requests at once', async () => {
    const maker = await createTestUser('maker-double-close@test.local');
    const customer = await customerService.createCustomer(pool, {
      customerType: 'individual',
      branchId: branchAId,
      fullName: 'Double Closure Target',
      ghanaCardNo: 'GHA-555555555-5',
      createdBy: maker,
    });

    await customerService.requestClosure(pool, { customerId: customer.id, reasonCode: 'a', requestedBy: maker });
    await expect(
      customerService.requestClosure(pool, { customerId: customer.id, reasonCode: 'b', requestedBy: maker })
    ).rejects.toThrow(customerService.CustomerConflictError);
  });

  test('branch transfer moves the customer and records history', async () => {
    const actor = await createTestUser('maker-transfer@test.local');
    const customer = await customerService.createCustomer(pool, {
      customerType: 'individual',
      branchId: branchAId,
      fullName: 'Transfer Target',
      ghanaCardNo: 'GHA-666666666-6',
      createdBy: actor,
    });

    const moved = await customerService.transferCustomerBranch(pool, {
      customerId: customer.id,
      toBranchId: branchBId,
      transferredBy: actor,
      reason: 'relocated',
    });
    expect(moved.branch_id).toBe(branchBId);

    const { rows: history } = await pool.query('SELECT * FROM customer_branch_transfers WHERE customer_id = $1', [
      customer.id,
    ]);
    expect(history).toHaveLength(1);
    expect(history[0].from_branch_id).toBe(branchAId);
    expect(history[0].to_branch_id).toBe(branchBId);
  });

  test('credit bureau lookup stores a clearly-labeled stub response', async () => {
    const actor = await createTestUser('maker-bureau@test.local');
    const customer = await customerService.createCustomer(pool, {
      customerType: 'individual',
      branchId: branchAId,
      fullName: 'Bureau Target',
      ghanaCardNo: 'GHA-777777777-7',
      createdBy: actor,
    });

    const lookup = await customerService.lookupCreditBureau(pool, { customerId: customer.id, requestedBy: actor });
    expect(lookup.response_payload.stub).toBe(true);
    expect(typeof lookup.response_payload.score).toBe('number');

    const history = await customerService.listCreditBureauLookups(pool, { customerId: customer.id });
    expect(history).toHaveLength(1);
  });

  test('customer 360 aggregates documents, next-of-kin, and credit bureau history', async () => {
    const actor = await createTestUser('maker-360@test.local');
    const customer = await customerService.createCustomer(pool, {
      customerType: 'individual',
      branchId: branchAId,
      fullName: '360 Target',
      ghanaCardNo: 'GHA-888888888-8',
      createdBy: actor,
    });

    await customerService.attachDocument(pool, {
      customerId: customer.id,
      documentType: 'photo',
      fileUrl: 'https://files.example/x.jpg',
      uploadedBy: actor,
    });
    await customerService.addNextOfKin(pool, { customerId: customer.id, fullName: 'Kin Person', createdBy: actor });
    await customerService.lookupCreditBureau(pool, { customerId: customer.id, requestedBy: actor });

    const profile = await customerService.getCustomer360(pool, { customerId: customer.id });
    expect(profile.documents).toHaveLength(1);
    expect(profile.nextOfKin).toHaveLength(1);
    expect(profile.creditBureauLookups).toHaveLength(1);
    expect(profile.pendingModules.length).toBeGreaterThan(0);
  });
});
