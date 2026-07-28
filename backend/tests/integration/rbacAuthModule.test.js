'use strict';

// Exercises the RBAC/auth HTTP routes added to power the frontend's Admin
// Back Office (GET /auth/me, GET /rbac/users, GET/DELETE
// /rbac/roles/:id/permissions, PATCH /rbac/users/:id/status) plus the CORS
// preflight response — through the real Express app via supertest, since
// these are route-layer additions rather than a new service module.
// Requires TEST_DATABASE_URL — see backend/README.md.

require('dotenv').config();
const { Pool } = require('pg');
const { execFileSync } = require('child_process');
const path = require('path');
const request = require('supertest');

const { createApp } = require('../../src/app');
const { hashPassword } = require('../../src/utils/password');

const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

describeIfDb('RBAC/auth HTTP routes (Module 11 additions)', () => {
  let pool;
  let app;
  let hqBranchId;
  let systemAdminRoleId;
  let ownerRoleId;
  let adminToken;
  let adminUserId;

  beforeAll(async () => {
    execFileSync('node', [path.join(__dirname, '../../src/db/migrate.js'), '--test'], {
      env: { ...process.env },
      stdio: 'inherit',
    });

    pool = new Pool({ connectionString });
    app = createApp(pool);

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

    const { rows: hqRows } = await pool.query("SELECT id FROM branches WHERE code = 'HQ'");
    hqBranchId = hqRows[0].id;
    const { rows: adminRoleRows } = await pool.query("SELECT id FROM roles WHERE name = 'system_admin'");
    systemAdminRoleId = adminRoleRows[0].id;
    const { rows: ownerRoleRows } = await pool.query("SELECT id FROM roles WHERE name = 'owner'");
    ownerRoleId = ownerRoleRows[0].id;

    const passwordHash = await hashPassword('TestPassword123!');
    const { rows } = await pool.query(
      `INSERT INTO users (full_name, email, password_hash, role_id, home_branch_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      ['RBAC Test Admin', 'rbac-admin@test.local', passwordHash, systemAdminRoleId, hqBranchId]
    );
    adminUserId = rows[0].id;

    const loginRes = await request(app)
      .post('/auth/login')
      .send({ email: 'rbac-admin@test.local', password: 'TestPassword123!' });
    adminToken = loginRes.body.token;
  });

  afterAll(async () => {
    await pool.end();
  });

  test('CORS preflight responds with permissive headers', async () => {
    const res = await request(app)
      .options('/auth/me')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'GET');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toContain('GET');
  });

  test('GET /auth/me returns the logged-in user, role, and permission set', async () => {
    const res = await request(app).get('/auth/me').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('rbac-admin@test.local');
    expect(res.body.roleName).toBe('system_admin');
    expect(res.body.permissions).toEqual(expect.arrayContaining(['rbac.manage_users', 'rbac.manage_roles']));
  });

  test('GET /auth/me 401s without a token', async () => {
    const res = await request(app).get('/auth/me');
    expect(res.status).toBe(401);
  });

  test('GET /rbac/users lists users and supports role/branch/status/search filters', async () => {
    const passwordHash = await hashPassword('TestPassword123!');
    const branch = await pool.query(
      `INSERT INTO branches (code, name) VALUES ('RBAC-01', 'RBAC Test Branch') RETURNING id`
    );
    const otherBranchId = branch.rows[0].id;
    const { rows: ownerRows } = await pool.query(
      `INSERT INTO users (full_name, email, password_hash, role_id, home_branch_id, status)
       VALUES ($1, $2, $3, $4, $5, 'suspended') RETURNING id`,
      ['Findable Owner', 'findable-owner@test.local', passwordHash, ownerRoleId, otherBranchId]
    );

    const all = await request(app).get('/rbac/users').set('Authorization', `Bearer ${adminToken}`);
    expect(all.status).toBe(200);
    expect(all.body.some((u) => Number(u.id) === Number(adminUserId))).toBe(true);

    const byRole = await request(app)
      .get('/rbac/users')
      .query({ roleId: ownerRoleId })
      .set('Authorization', `Bearer ${adminToken}`);
    expect(byRole.body.every((u) => Number(u.role_id) === Number(ownerRoleId))).toBe(true);
    expect(byRole.body.some((u) => Number(u.id) === Number(ownerRows[0].id))).toBe(true);

    const byBranch = await request(app)
      .get('/rbac/users')
      .query({ branchId: otherBranchId })
      .set('Authorization', `Bearer ${adminToken}`);
    expect(byBranch.body.every((u) => Number(u.home_branch_id) === Number(otherBranchId))).toBe(true);

    const byStatus = await request(app)
      .get('/rbac/users')
      .query({ status: 'suspended' })
      .set('Authorization', `Bearer ${adminToken}`);
    expect(byStatus.body.some((u) => Number(u.id) === Number(ownerRows[0].id))).toBe(true);
    expect(byStatus.body.every((u) => u.status === 'suspended')).toBe(true);

    const bySearch = await request(app)
      .get('/rbac/users')
      .query({ search: 'Findable' })
      .set('Authorization', `Bearer ${adminToken}`);
    expect(bySearch.body.length).toBe(1);
    expect(Number(bySearch.body[0].id)).toBe(Number(ownerRows[0].id));
  });

  test('GET /rbac/users requires rbac.manage_users (403 for a role without it)', async () => {
    const passwordHash = await hashPassword('TestPassword123!');
    const { rows: loanOfficerRoleRows } = await pool.query("SELECT id FROM roles WHERE name = 'loan_officer'");
    await pool.query(
      `INSERT INTO users (full_name, email, password_hash, role_id, home_branch_id)
       VALUES ($1, $2, $3, $4, $5)`,
      ['Unprivileged Officer', 'unprivileged@test.local', passwordHash, loanOfficerRoleRows[0].id, hqBranchId]
    );
    const loginRes = await request(app)
      .post('/auth/login')
      .send({ email: 'unprivileged@test.local', password: 'TestPassword123!' });

    const res = await request(app)
      .get('/rbac/users')
      .set('Authorization', `Bearer ${loginRes.body.token}`);
    expect(res.status).toBe(403);
  });

  test('GET/POST/DELETE /rbac/roles/:roleId/permissions round-trips a grant and a revoke', async () => {
    const before = await request(app)
      .get(`/rbac/roles/${ownerRoleId}/permissions`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(before.status).toBe(200);
    const hadIt = before.body.includes('sysadmin.manage_backups');
    if (hadIt) {
      await pool.query(
        `DELETE FROM role_permissions WHERE role_id = $1 AND permission_id = (SELECT id FROM permissions WHERE code = 'sysadmin.manage_backups')`,
        [ownerRoleId]
      );
    }

    const grant = await request(app)
      .post(`/rbac/roles/${ownerRoleId}/permissions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ permissionCode: 'sysadmin.manage_backups' });
    expect(grant.status).toBe(204);

    const afterGrant = await request(app)
      .get(`/rbac/roles/${ownerRoleId}/permissions`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(afterGrant.body).toContain('sysadmin.manage_backups');

    const revoke = await request(app)
      .delete(`/rbac/roles/${ownerRoleId}/permissions/sysadmin.manage_backups`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(revoke.status).toBe(204);

    const afterRevoke = await request(app)
      .get(`/rbac/roles/${ownerRoleId}/permissions`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(afterRevoke.body).not.toContain('sysadmin.manage_backups');
  });

  test('PATCH /rbac/users/:userId/status suspends and reactivates a user, validates the enum, and 404s on an unknown id', async () => {
    const passwordHash = await hashPassword('TestPassword123!');
    const { rows } = await pool.query(
      `INSERT INTO users (full_name, email, password_hash, role_id, home_branch_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      ['Suspendable User', 'suspendable@test.local', passwordHash, ownerRoleId, hqBranchId]
    );
    const userId = rows[0].id;

    const suspend = await request(app)
      .patch(`/rbac/users/${userId}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'suspended' });
    expect(suspend.status).toBe(200);
    expect(suspend.body.status).toBe('suspended');

    const reactivate = await request(app)
      .patch(`/rbac/users/${userId}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'active' });
    expect(reactivate.body.status).toBe('active');

    const badStatus = await request(app)
      .patch(`/rbac/users/${userId}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'bogus' });
    expect(badStatus.status).toBe(400);

    const notFound = await request(app)
      .patch('/rbac/users/999999/status')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'suspended' });
    expect(notFound.status).toBe(404);
  });

  test('GET /approvals lists approval_requests and filters by status/actionType', async () => {
    await pool.query(
      `INSERT INTO approval_requests (action_type, entity_type, entity_id, branch_id, amount_pesewas, requested_by, status)
       VALUES ('loan.disburse', 'loan', '1', $1, 500000, $2, 'pending')`,
      [hqBranchId, adminUserId]
    );

    const all = await request(app).get('/approvals').set('Authorization', `Bearer ${adminToken}`);
    expect(all.status).toBe(200);
    expect(all.body.some((a) => a.action_type === 'loan.disburse')).toBe(true);

    const byStatus = await request(app)
      .get('/approvals')
      .query({ status: 'pending', actionType: 'loan.disburse' })
      .set('Authorization', `Bearer ${adminToken}`);
    expect(byStatus.body.every((a) => a.status === 'pending' && a.action_type === 'loan.disburse')).toBe(true);
  });

  test('GET /approvals requires approval.decide', async () => {
    const passwordHash = await hashPassword('TestPassword123!');
    const { rows: loanOfficerRoleRows } = await pool.query("SELECT id FROM roles WHERE name = 'loan_officer'");
    await pool.query(
      `INSERT INTO users (full_name, email, password_hash, role_id, home_branch_id)
       VALUES ($1, $2, $3, $4, $5)`,
      ['No Decide Permission', 'no-decide@test.local', passwordHash, loanOfficerRoleRows[0].id, hqBranchId]
    );
    const loginRes = await request(app)
      .post('/auth/login')
      .send({ email: 'no-decide@test.local', password: 'TestPassword123!' });
    const res = await request(app).get('/approvals').set('Authorization', `Bearer ${loginRes.body.token}`);
    expect(res.status).toBe(403);
  });

  test('GET/POST/PATCH /approvals/thresholds round-trips a threshold, upserts on the same action/branch pair, and validates required fields', async () => {
    const missingFields = await request(app)
      .post('/approvals/thresholds')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ actionType: 'test.threshold' });
    expect(missingFields.status).toBe(400);

    const created = await request(app)
      .post('/approvals/thresholds')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ actionType: 'test.threshold', amountThresholdPesewas: 100000, requiredApproverRoleId: ownerRoleId });
    expect(created.status).toBe(201);
    expect(Number(created.body.amount_threshold_pesewas)).toBe(100000);

    const upserted = await request(app)
      .post('/approvals/thresholds')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ actionType: 'test.threshold', amountThresholdPesewas: 250000, requiredApproverRoleId: ownerRoleId });
    expect(Number(upserted.body.id)).toBe(Number(created.body.id));
    expect(Number(upserted.body.amount_threshold_pesewas)).toBe(250000);

    const list = await request(app)
      .get('/approvals/thresholds')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(list.body.some((t) => Number(t.id) === Number(created.body.id))).toBe(true);

    const patched = await request(app)
      .patch(`/approvals/thresholds/${created.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ amountThresholdPesewas: 300000 });
    expect(Number(patched.body.amount_threshold_pesewas)).toBe(300000);

    const notFound = await request(app)
      .patch('/approvals/thresholds/999999')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ amountThresholdPesewas: 1 });
    expect(notFound.status).toBe(404);
  });

  test('GET /branches/:id/cross-branch-grants lists grants for a branch, including revoked ones', async () => {
    const passwordHash = await hashPassword('TestPassword123!');
    const { rows: granteeRows } = await pool.query(
      `INSERT INTO users (full_name, email, password_hash, role_id, home_branch_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      ['Grant Recipient', 'grant-recipient@test.local', passwordHash, ownerRoleId, hqBranchId]
    );

    const grantRes = await request(app)
      .post(`/branches/${hqBranchId}/cross-branch-grants`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ userId: granteeRows[0].id, startDate: '2026-01-01', endDate: '2026-12-31' });
    expect(grantRes.status).toBe(201);

    const list = await request(app)
      .get(`/branches/${hqBranchId}/cross-branch-grants`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(list.status).toBe(200);
    expect(list.body.some((g) => Number(g.id) === Number(grantRes.body.id))).toBe(true);
    expect(list.body[0]).toHaveProperty('user_full_name');
  });
});
