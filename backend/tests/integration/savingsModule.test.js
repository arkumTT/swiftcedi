'use strict';

// Exercises Module 4 (savings, susu, standing orders) against a real
// Postgres instance: deposit/withdrawal GL correctness on a LIABILITY
// control account, idempotent posting, threshold-gated maker-checker
// withdrawals, charges, the susu field-collection -> remittance -> payout
// chain (including the Cash-with-Agents leg Module 10 will reconcile),
// and standing-order failure/retry/suspend. Pure charge/commission/
// scheduling math is covered in tests/unit/savingsMath.test.js.
// Requires TEST_DATABASE_URL — see backend/README.md.

require('dotenv').config();
const { Pool } = require('pg');
const { execFileSync } = require('child_process');
const path = require('path');

const savingsService = require('../../src/modules/savings/savingsService');
const susuService = require('../../src/modules/savings/susuService');
const standingOrderService = require('../../src/modules/savings/standingOrderService');
const branchService = require('../../src/modules/branch/branchService');
const customerService = require('../../src/modules/customer/customerService');
const approvalWorkflow = require('../../src/shared/approvalWorkflow');
const glPosting = require('../../src/shared/glPosting');

const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

describeIfDb('Module 4: savings, susu & standing orders', () => {
  let pool;
  let branchId;
  let gl;
  let ownerRoleId;
  let maker;
  let checker;
  let agent;

  beforeAll(async () => {
    execFileSync('node', [path.join(__dirname, '../../src/db/migrate.js'), '--test'], {
      env: { ...process.env },
      stdio: 'inherit',
    });

    pool = new Pool({ connectionString });

    // Same targeted cleanup as the other suites — see branchModule.test.js
    // for why TRUNCATE ... CASCADE is unsafe against branches/gl_accounts.
    // Immutable tables need TRUNCATE (their triggers block DELETE).
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
    savingsService.registerSavingsExecutionHandlers();

    const { rows: roleRows } = await pool.query("SELECT id FROM roles WHERE name = 'owner'");
    ownerRoleId = roleRows[0].id;
    maker = await createTestUser('sav-maker@test.local');
    checker = await createTestUser('sav-checker@test.local');
    agent = await createTestUser('sav-agent@test.local');

    const branch = await branchService.createBranch(pool, { code: 'SAV-01', name: 'Savings Test Branch', createdBy: maker });
    branchId = branch.id;
    gl = await savingsService.getBranchGlAccounts(pool, branchId);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function createTestUser(email) {
    const { rows } = await pool.query(
      `INSERT INTO users (full_name, email, password_hash, role_id, home_branch_id)
       VALUES ($1, $1, 'x', $2, (SELECT id FROM branches WHERE code = 'HQ')) RETURNING id`,
      [email, ownerRoleId]
    );
    return rows[0].id;
  }

  let cardSeq = 0;
  async function createVerifiedCustomer(name) {
    cardSeq += 1;
    const customer = await customerService.createCustomer(pool, {
      customerType: 'individual',
      branchId,
      fullName: name,
      ghanaCardNo: `GHA-7000000${String(cardSeq).padStart(2, '0')}-1`,
      createdBy: maker,
    });
    await customerService.updateKycStatus(pool, { customerId: customer.id, kycStatus: 'verified', actorId: maker });
    return customer;
  }

  let productSeq = 0;
  async function createProduct(overrides = {}) {
    productSeq += 1;
    return savingsService.createSavingsProduct(pool, {
      name: `Savings Product ${productSeq}`,
      code: `SP${productSeq}`,
      minBalancePesewas: 0,
      maintenanceFeePesewas: 0,
      withdrawalFeePesewas: 0,
      minBalanceChargePesewas: 0,
      withdrawalApprovalThresholdPesewas: 1000000,
      createdBy: maker,
      ...overrides,
    });
  }

  async function openFundedAccount(amountPesewas, productOverrides = {}) {
    const customer = await createVerifiedCustomer(`Holder ${cardSeq + 1}`);
    const product = await createProduct(productOverrides);
    const account = await savingsService.openAccount(pool, {
      customerId: customer.id,
      productId: product.id,
      createdBy: maker,
    });
    if (amountPesewas > 0) {
      await savingsService.deposit(pool, { accountId: account.id, amountPesewas, depositedBy: maker });
    }
    return { customer, product, account: await savingsService.getAccount(pool, account.id) };
  }

  async function decideAs(approvalId, decidedBy, decision = 'approved') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await approvalWorkflow.decide(client, { approvalId, decidedBy, decision });
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  const balOf = (accountId) => glPosting.getAccountBalance(pool, { accountId, branchId });

  test('opening an account requires an active, KYC-verified customer', async () => {
    const product = await createProduct();
    const unverified = await customerService.createCustomer(pool, {
      customerType: 'individual',
      branchId,
      fullName: 'Unverified Saver',
      ghanaCardNo: 'GHA-710000001-1',
      createdBy: maker,
    });
    await expect(
      savingsService.openAccount(pool, { customerId: unverified.id, productId: product.id, createdBy: maker })
    ).rejects.toThrow(savingsService.SavingsConflictError);
  });

  test('a deposit credits the customer-deposits LIABILITY and debits cash', async () => {
    const depositsBefore = await balOf(gl.customer_deposits_account_id);
    const cashBefore = await balOf(gl.cash_in_hand_account_id);

    const { account } = await openFundedAccount(50000);

    expect(Number(account.balance_pesewas)).toBe(50000);
    // Liability control is credit-normal, so a deposit increases it.
    expect((await balOf(gl.customer_deposits_account_id)) - depositsBefore).toBe(50000);
    expect((await balOf(gl.cash_in_hand_account_id)) - cashBefore).toBe(50000);
  });

  test('a repeated idempotency key does not double-post the deposit', async () => {
    const { account } = await openFundedAccount(0);
    const first = await savingsService.deposit(pool, {
      accountId: account.id,
      amountPesewas: 25000,
      depositedBy: maker,
      idempotencyKey: 'idem-dep-1',
    });
    expect(first.idempotentReplay).toBe(false);

    const replay = await savingsService.deposit(pool, {
      accountId: account.id,
      amountPesewas: 25000,
      depositedBy: maker,
      idempotencyKey: 'idem-dep-1',
    });
    expect(replay.idempotentReplay).toBe(true);
    expect(Number(replay.transaction.id)).toBe(Number(first.transaction.id));

    const after = await savingsService.getAccount(pool, account.id);
    expect(Number(after.balance_pesewas)).toBe(25000); // not 50000
  });

  test('a below-threshold withdrawal pays out immediately and charges the withdrawal fee', async () => {
    const { account } = await openFundedAccount(50000, {
      withdrawalFeePesewas: 200,
      withdrawalApprovalThresholdPesewas: 40000,
    });
    const feeIncomeBefore = await balOf(gl.savings_fee_income_account_id);

    const result = await savingsService.requestWithdrawal(pool, {
      accountId: account.id,
      amountPesewas: 10000,
      requestedBy: maker,
    });

    expect(result.paidOut).toBe(true);
    expect(result.feePesewas).toBe(200);
    expect(result.balanceAfterPesewas).toBe(39800);
    expect((await balOf(gl.savings_fee_income_account_id)) - feeIncomeBefore).toBe(200);
  });

  test('an at-or-above-threshold withdrawal is held for maker-checker and only pays out once approved', async () => {
    const { account } = await openFundedAccount(100000, { withdrawalApprovalThresholdPesewas: 50000 });

    const requested = await savingsService.requestWithdrawal(pool, {
      accountId: account.id,
      amountPesewas: 60000,
      requestedBy: maker,
    });
    expect(requested.paidOut).toBe(false);
    expect(requested.withdrawalRequest.threshold_flag).toBe(true);

    // Money has NOT moved yet.
    expect(Number((await savingsService.getAccount(pool, account.id)).balance_pesewas)).toBe(100000);

    // Settling before approval is refused.
    await expect(
      savingsService.settleApprovedWithdrawal(pool, {
        withdrawalRequestId: requested.withdrawalRequest.id,
        paidBy: maker,
      })
    ).rejects.toThrow(savingsService.SavingsConflictError);

    // Maker cannot approve their own request.
    await expect(decideAs(requested.approvalRequest.id, maker)).rejects.toThrow(
      approvalWorkflow.MakerCheckerViolationError
    );

    await decideAs(requested.approvalRequest.id, checker);
    const settled = await savingsService.settleApprovedWithdrawal(pool, {
      withdrawalRequestId: requested.withdrawalRequest.id,
      paidBy: maker,
    });
    expect(settled.paidOut).toBe(true);
    expect(Number((await savingsService.getAccount(pool, account.id)).balance_pesewas)).toBe(40000);
  });

  test('a branch-level approval_thresholds row overrides the product threshold', async () => {
    const { account } = await openFundedAccount(100000, { withdrawalApprovalThresholdPesewas: 90000 });
    const { rows: roleRows } = await pool.query("SELECT id FROM roles WHERE name = 'branch_manager'");
    await pool.query(
      `INSERT INTO approval_thresholds (action_type, branch_id, amount_threshold_pesewas, required_approver_role_id)
       VALUES ('savings.withdraw', $1, 5000, $2)`,
      [branchId, roleRows[0].id]
    );

    // 10000 is under the product's 90000 but over the branch override of 5000.
    const result = await savingsService.requestWithdrawal(pool, {
      accountId: account.id,
      amountPesewas: 10000,
      requestedBy: maker,
    });
    expect(result.paidOut).toBe(false);
    expect(result.thresholdPesewas).toBe(5000);

    await pool.query("DELETE FROM approval_thresholds WHERE action_type = 'savings.withdraw'");
  });

  test('a withdrawal that would breach the minimum balance is rejected', async () => {
    const { account } = await openFundedAccount(10000, { minBalancePesewas: 5000 });
    await expect(
      savingsService.requestWithdrawal(pool, { accountId: account.id, amountPesewas: 6000, requestedBy: maker })
    ).rejects.toThrow(savingsService.SavingsValidationError);
  });

  test('charges debit the customer and credit savings fee income, and the min-balance charge only applies below the minimum', async () => {
    const { account } = await openFundedAccount(50000, {
      minBalancePesewas: 40000,
      maintenanceFeePesewas: 500,
      minBalanceChargePesewas: 300,
    });
    const feeIncomeBefore = await balOf(gl.savings_fee_income_account_id);

    // Balance 50000 is above the 40000 minimum: maintenance only.
    const first = await savingsService.applyCharges(pool, { accountId: account.id, appliedBy: maker });
    expect(first.applied.map((a) => a.chargeType)).toEqual(['maintenance_fee']);
    expect(first.balancePesewas).toBe(49500);

    // Drop below the minimum, then both charges apply.
    await savingsService.applyMovement(pool, {
      accountId: account.id,
      txnType: 'withdrawal',
      deltaPesewas: -15000,
      createdBy: maker,
      reference: `TEST-DROP-${account.id}`,
      buildGlLines: ({ glAccounts, branchId: b }) => [
        { accountId: glAccounts.customer_deposits_account_id, debitPesewas: 15000, branchId: b },
        { accountId: glAccounts.cash_in_hand_account_id, creditPesewas: 15000, branchId: b },
      ],
    });

    const second = await savingsService.applyCharges(pool, { accountId: account.id, appliedBy: maker });
    expect(second.applied.map((a) => a.chargeType).sort()).toEqual(['maintenance_fee', 'min_balance_charge']);
    expect((await balOf(gl.savings_fee_income_account_id)) - feeIncomeBefore).toBe(500 + 500 + 300);
  });

  test('an account with a non-zero balance cannot be closed', async () => {
    const { account } = await openFundedAccount(5000);
    await expect(savingsService.closeAccount(pool, { accountId: account.id, closedBy: maker })).rejects.toThrow(
      savingsService.SavingsConflictError
    );
  });

  test('an account with an active overdraft limit cannot be closed even at a zero balance', async () => {
    const { account } = await openFundedAccount(0);
    // Simulates what loanService.activateOverdraft sets on disbursement —
    // this suite doesn't depend on the loan module, so the column is set
    // directly rather than going through a real overdraft loan.
    await pool.query('UPDATE savings_accounts SET overdraft_limit_pesewas = 500000 WHERE id = $1', [account.id]);

    await expect(savingsService.closeAccount(pool, { accountId: account.id, closedBy: maker })).rejects.toThrow(
      /active overdraft facility/
    );

    await pool.query('UPDATE savings_accounts SET overdraft_limit_pesewas = 0 WHERE id = $1', [account.id]);
    await expect(savingsService.closeAccount(pool, { accountId: account.id, closedBy: maker })).resolves.toMatchObject({
      status: 'closed',
    });
  });

  test('the stored subledger balance always reconciles to the immutable ledger and to the GL control account', async () => {
    const { account } = await openFundedAccount(30000, { withdrawalFeePesewas: 100, withdrawalApprovalThresholdPesewas: 1000000 });
    await savingsService.requestWithdrawal(pool, { accountId: account.id, amountPesewas: 5000, requestedBy: maker });
    await savingsService.deposit(pool, { accountId: account.id, amountPesewas: 2000, depositedBy: maker });

    const accountReconciliation = await savingsService.reconcileAccount(pool, { accountId: account.id });
    expect(accountReconciliation.reconciled).toBe(true);

    const branchReconciliation = await savingsService.reconcileBranchDeposits(pool, { branchId });
    expect(branchReconciliation.reconciled).toBe(true);
    expect(branchReconciliation.variancePesewas).toBe(0);
  });

  test('savings_transactions rows are immutable apart from the one-time journal_entry_id stamp', async () => {
    const { account } = await openFundedAccount(1000);
    const { rows } = await pool.query('SELECT * FROM savings_transactions WHERE account_id = $1 LIMIT 1', [account.id]);
    const txn = rows[0];

    await expect(
      pool.query('UPDATE savings_transactions SET amount_pesewas = 1 WHERE id = $1', [txn.id])
    ).rejects.toThrow(/immutable/);
    await expect(pool.query('DELETE FROM savings_transactions WHERE id = $1', [txn.id])).rejects.toThrow(/immutable/);
  });

  // --- Susu ------------------------------------------------------------------

  test('a susu collection puts cash with the AGENT (not the branch till) and accrues commission', async () => {
    const customer = await createVerifiedCustomer('Susu Saver');
    const susu = await susuService.createSusuAccount(pool, {
      customerId: customer.id,
      cycleLengthDays: 30,
      expectedCollectionPesewas: 1000,
      targetAmountPesewas: 30000,
      commissionRateBps: 500,
      assignedAgentId: agent,
      createdBy: maker,
    });

    const cashWithAgentsBefore = await balOf(gl.cash_with_agents_account_id);
    const cashInHandBefore = await balOf(gl.cash_in_hand_account_id);
    const susuDepositsBefore = await balOf(gl.susu_deposits_account_id);

    const result = await susuService.recordCollection(pool, {
      susuAccountId: susu.id,
      agentId: agent,
      amountPesewas: 10000,
      idempotencyKey: 'susu-col-a',
      collectionDate: '2026-01-02',
    });

    expect(result.commissionPesewas).toBe(500); // 5% of 10000
    expect((await balOf(gl.cash_with_agents_account_id)) - cashWithAgentsBefore).toBe(10000);
    // The branch till is untouched — the agent is still holding the cash.
    expect((await balOf(gl.cash_in_hand_account_id)) - cashInHandBefore).toBe(0);
    expect((await balOf(gl.susu_deposits_account_id)) - susuDepositsBefore).toBe(10000);
  });

  test('a replayed collection idempotency key returns the original and does not double-count', async () => {
    const customer = await createVerifiedCustomer('Flaky Connection Saver');
    const susu = await susuService.createSusuAccount(pool, {
      customerId: customer.id,
      cycleLengthDays: 30,
      expectedCollectionPesewas: 1000,
      targetAmountPesewas: 30000,
      assignedAgentId: agent,
      createdBy: maker,
    });

    const first = await susuService.recordCollection(pool, {
      susuAccountId: susu.id,
      agentId: agent,
      amountPesewas: 3000,
      idempotencyKey: 'susu-retry-key',
    });
    const replay = await susuService.recordCollection(pool, {
      susuAccountId: susu.id,
      agentId: agent,
      amountPesewas: 3000,
      idempotencyKey: 'susu-retry-key',
    });

    expect(first.idempotentReplay).toBe(false);
    expect(replay.idempotentReplay).toBe(true);
    expect(Number(replay.collection.id)).toBe(Number(first.collection.id));
    expect(Number((await susuService.getSusuAccount(pool, susu.id)).collected_pesewas)).toBe(3000);
  });

  test('agent remittance moves cash-with-agents into the branch till and stamps the collections once', async () => {
    const customer = await createVerifiedCustomer('Remittance Saver');
    const susu = await susuService.createSusuAccount(pool, {
      customerId: customer.id,
      cycleLengthDays: 30,
      expectedCollectionPesewas: 1000,
      targetAmountPesewas: 30000,
      assignedAgentId: agent,
      createdBy: maker,
    });
    const localAgent = await createTestUser('remit-agent@test.local');
    for (const key of ['rem-1', 'rem-2']) {
      await susuService.recordCollection(pool, {
        susuAccountId: susu.id,
        agentId: localAgent,
        amountPesewas: 4000,
        idempotencyKey: key,
      });
    }

    const cashWithAgentsBefore = await balOf(gl.cash_with_agents_account_id);
    const cashInHandBefore = await balOf(gl.cash_in_hand_account_id);

    const remittance = await susuService.recordRemittance(pool, {
      agentId: localAgent,
      branchId,
      receivedBy: maker,
      remittedOn: '2026-01-05',
    });
    expect(Number(remittance.amount_pesewas)).toBe(8000);
    expect(remittance.collection_count).toBe(2);
    expect((await balOf(gl.cash_with_agents_account_id)) - cashWithAgentsBefore).toBe(-8000);
    expect((await balOf(gl.cash_in_hand_account_id)) - cashInHandBefore).toBe(8000);

    // Each collection is attached to exactly one remittance, so Module 10
    // can never reconcile the same collection twice.
    const collections = await susuService.listCollections(pool, { agentId: localAgent });
    expect(collections.every((c) => Number(c.remittance_id) === Number(remittance.id))).toBe(true);

    // Nothing outstanding left to remit.
    await expect(
      susuService.recordRemittance(pool, { agentId: localAgent, branchId, receivedBy: maker })
    ).rejects.toThrow(susuService.SusuConflictError);
  });

  test('cycle outcome is completed when the target is met and uncompleted when it is not, and payout settles into savings', async () => {
    const customer = await createVerifiedCustomer('Cycle Saver');
    const product = await createProduct();
    const savingsAccount = await savingsService.openAccount(pool, {
      customerId: customer.id,
      productId: product.id,
      createdBy: maker,
    });
    const susu = await susuService.createSusuAccount(pool, {
      customerId: customer.id,
      cycleLengthDays: 10,
      expectedCollectionPesewas: 1000,
      targetAmountPesewas: 5000,
      payoutSavingsAccountId: savingsAccount.id,
      assignedAgentId: agent,
      createdBy: maker,
    });
    const cycleAgent = await createTestUser('cycle-agent@test.local');
    await susuService.recordCollection(pool, {
      susuAccountId: susu.id,
      agentId: cycleAgent,
      amountPesewas: 5000,
      idempotencyKey: 'cycle-full',
    });

    const completed = await susuService.completeCycle(pool, { susuAccountId: susu.id, completedBy: maker });
    expect(completed.status).toBe('completed');

    const susuDepositsBefore = await balOf(gl.susu_deposits_account_id);
    const payout = await susuService.payOutCycle(pool, { susuAccountId: susu.id, paidBy: maker });
    expect(payout.paidPesewas).toBe(5000);
    expect(payout.susuAccount.status).toBe('paid_out');
    expect(Number((await savingsService.getAccount(pool, savingsAccount.id)).balance_pesewas)).toBe(5000);
    expect((await balOf(gl.susu_deposits_account_id)) - susuDepositsBefore).toBe(-5000);
  });

  test('a cycle that falls short of target is marked uncompleted but still pays out what was saved', async () => {
    const customer = await createVerifiedCustomer('Short Cycle Saver');
    const product = await createProduct();
    const savingsAccount = await savingsService.openAccount(pool, {
      customerId: customer.id,
      productId: product.id,
      createdBy: maker,
    });
    const susu = await susuService.createSusuAccount(pool, {
      customerId: customer.id,
      cycleLengthDays: 10,
      expectedCollectionPesewas: 1000,
      targetAmountPesewas: 10000,
      payoutSavingsAccountId: savingsAccount.id,
      createdBy: maker,
    });
    const shortAgent = await createTestUser('short-agent@test.local');
    await susuService.recordCollection(pool, {
      susuAccountId: susu.id,
      agentId: shortAgent,
      amountPesewas: 2500,
      idempotencyKey: 'cycle-short',
    });

    const outcome = await susuService.completeCycle(pool, { susuAccountId: susu.id, completedBy: maker });
    expect(outcome.status).toBe('uncompleted');

    const payout = await susuService.payOutCycle(pool, { susuAccountId: susu.id, paidBy: maker });
    expect(payout.paidPesewas).toBe(2500);
    expect(Number((await savingsService.getAccount(pool, savingsAccount.id)).balance_pesewas)).toBe(2500);
  });

  // --- Standing orders --------------------------------------------------------

  test('a standing order transfers on its due date and rolls the next run date forward', async () => {
    const { account: source } = await openFundedAccount(50000);
    const { account: destination } = await openFundedAccount(0);

    const order = await standingOrderService.createStandingOrder(pool, {
      sourceAccountId: source.id,
      destinationAccountId: destination.id,
      amountPesewas: 5000,
      frequency: 'monthly',
      startDate: '2026-02-01',
      createdBy: maker,
    });

    const result = await standingOrderService.executeOrder(pool, {
      standingOrderId: order.id,
      runDate: '2026-02-01',
      executedBy: maker,
    });
    expect(result.success).toBe(true);
    expect(result.sourceBalanceAfterPesewas).toBe(45000);
    expect(result.destinationBalanceAfterPesewas).toBe(5000);
    expect(result.nextRunDate).toBe('2026-03-01');
  });

  test('an insufficient-funds run is recorded as a failure, reschedules by the retry policy, and suspends after max failures', async () => {
    const { account: source } = await openFundedAccount(3000, { minBalancePesewas: 1000 });
    const { account: destination } = await openFundedAccount(0);

    const order = await standingOrderService.createStandingOrder(pool, {
      sourceAccountId: source.id,
      destinationAccountId: destination.id,
      amountPesewas: 2500, // would leave 500, below the 1000 minimum
      frequency: 'monthly',
      startDate: '2026-02-01',
      retryAfterDays: 2,
      maxConsecutiveFailures: 2,
      createdBy: maker,
    });

    const first = await standingOrderService.executeOrder(pool, {
      standingOrderId: order.id,
      runDate: '2026-02-01',
      executedBy: maker,
    });
    expect(first.success).toBe(false);
    expect(first.consecutiveFailures).toBe(1);
    expect(first.suspended).toBe(false);
    expect(first.nextRunDate).toBe('2026-02-03'); // retryAfterDays applied

    const second = await standingOrderService.executeOrder(pool, {
      standingOrderId: order.id,
      runDate: '2026-02-03',
      executedBy: maker,
    });
    expect(second.success).toBe(false);
    expect(second.suspended).toBe(true);
    expect((await standingOrderService.getStandingOrder(pool, order.id)).status).toBe('suspended');

    // Suspended orders are skipped rather than retried forever.
    const third = await standingOrderService.executeOrder(pool, {
      standingOrderId: order.id,
      runDate: '2026-02-05',
      executedBy: maker,
    });
    expect(third.skipped).toBe(true);

    // Both failures are recorded — nothing fails silently.
    const runs = await standingOrderService.listRuns(pool, { standingOrderId: order.id, status: 'failed' });
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.failure_reason && r.customer_notified === false)).toBe(true);
  });

  test('executeDueOrders picks up only active orders that are actually due', async () => {
    const { account: source } = await openFundedAccount(50000);
    const { account: destination } = await openFundedAccount(0);
    const due = await standingOrderService.createStandingOrder(pool, {
      sourceAccountId: source.id,
      destinationAccountId: destination.id,
      amountPesewas: 1000,
      frequency: 'monthly',
      startDate: '2026-05-01',
      createdBy: maker,
    });
    const notYetDue = await standingOrderService.createStandingOrder(pool, {
      sourceAccountId: source.id,
      destinationAccountId: destination.id,
      amountPesewas: 1000,
      frequency: 'monthly',
      startDate: '2026-09-01',
      createdBy: maker,
    });

    const summary = await standingOrderService.executeDueOrders(pool, { asOfDate: '2026-05-01', executedBy: maker });
    const executedIds = summary.results.map((r) => r.standingOrderId);
    expect(executedIds).toContain(Number(due.id));
    expect(executedIds).not.toContain(Number(notYetDue.id));
  });

  test('cross-branch standing orders are rejected rather than posting a lopsided entry', async () => {
    const otherBranch = await branchService.createBranch(pool, {
      code: 'SAV-02',
      name: 'Other Savings Branch',
      createdBy: maker,
    });
    const { account: source } = await openFundedAccount(10000);

    const otherCustomer = await customerService.createCustomer(pool, {
      customerType: 'individual',
      branchId: otherBranch.id,
      fullName: 'Other Branch Saver',
      ghanaCardNo: 'GHA-720000001-1',
      createdBy: maker,
    });
    await customerService.updateKycStatus(pool, { customerId: otherCustomer.id, kycStatus: 'verified', actorId: maker });
    const product = await createProduct();
    const otherAccount = await savingsService.openAccount(pool, {
      customerId: otherCustomer.id,
      productId: product.id,
      createdBy: maker,
    });

    await expect(
      standingOrderService.createStandingOrder(pool, {
        sourceAccountId: source.id,
        destinationAccountId: otherAccount.id,
        amountPesewas: 1000,
        frequency: 'monthly',
        createdBy: maker,
      })
    ).rejects.toThrow(/cross-branch/);
  });
});
