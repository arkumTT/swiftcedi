'use strict';

// Exercises Module 6 (cashierService.js) against a real Postgres
// instance: till open/close (float issuance/return, variance
// computation), threshold-gated cash-back, always-approved reversals
// (glPosting.reverseJournalEntry swapping the original entry's lines),
// and day/month/year close-out — including the first real activation of
// Module 7's gl_periods lock (nothing before Module 6 ever created a row
// there) and the resulting prior-period-adjustment workflow. No dedicated
// pure-math file exists for this module — the only arithmetic (expected-
// balance/variance) is simple subtraction, exercised directly here rather
// than warranting its own unit-tested module like loan/savings/investment
// math. Requires TEST_DATABASE_URL — see backend/README.md.

require('dotenv').config();
const { Pool } = require('pg');
const { execFileSync } = require('child_process');
const path = require('path');

const cashierService = require('../../src/modules/cashier/cashierService');
const branchService = require('../../src/modules/branch/branchService');
const approvalWorkflow = require('../../src/shared/approvalWorkflow');
const glPosting = require('../../src/shared/glPosting');

const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

describeIfDb('Module 6: cashier, till & vault operations', () => {
  let pool;
  let branchId;
  let glAccounts;
  let ownerRoleId;
  let maker;
  let checker;

  beforeAll(async () => {
    execFileSync('node', [path.join(__dirname, '../../src/db/migrate.js'), '--test'], {
      env: { ...process.env },
      stdio: 'inherit',
    });

    pool = new Pool({ connectionString });

    // Same targeted-cleanup approach as the other suites. gl_prior_period_
    // adjustments/day_close_snapshots/transaction_reversals/cash_back_
    // requests/cashier_tills are all plain-DELETE-able (no immutability
    // trigger on any of them, unlike the append-only ledger tables) —
    // cleared here in FK order, ending with gl_periods (day_close_
    // snapshots references it) before the rest of the shared cleanup.
    await pool.query('TRUNCATE gl_journal_lines, gl_journal_entries RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE audit_log RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE loan_repayments RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE savings_transactions, susu_collections RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE overdraft_interest_accruals RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE investment_accruals RESTART IDENTITY CASCADE');
    for (const table of [
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
    cashierService.registerCashierExecutionHandlers();
    glPosting.registerGlExecutionHandlers();

    const { rows: roleRows } = await pool.query("SELECT id FROM roles WHERE name = 'owner'");
    ownerRoleId = roleRows[0].id;

    maker = await createTestUser('cashier-maker@test.local');
    checker = await createTestUser('cashier-checker@test.local');

    const branch = await branchService.createBranch(pool, { code: 'CSH-01', name: 'Cashier Test Branch', createdBy: maker });
    branchId = branch.id;
    glAccounts = await cashierService.getBranchGlAccounts(pool, branchId);
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

  /** Funds the branch's vault directly via a manual JV, same as a real institution injecting capital. */
  async function fundVault(amountPesewas, entryDate = '2026-01-01') {
    const { rows } = await pool.query("SELECT id FROM gl_accounts WHERE code = '4000'");
    return glPosting.postJournalEntry(pool, {
      branchId,
      reference: `FUND-VAULT-${Date.now()}-${Math.random()}`,
      entryDate,
      sourceModule: 'manual_jv',
      createdBy: maker,
      lines: [
        { accountId: glAccounts.vault_account_id, debitPesewas: amountPesewas, branchId },
        { accountId: rows[0].id, creditPesewas: amountPesewas, branchId },
      ],
    });
  }

  let cashierSeq = 0;
  async function nextCashierId() {
    cashierSeq += 1;
    return createTestUser(`till-cashier-${cashierSeq}@test.local`);
  }

  test('opening a till fails if the vault balance is insufficient', async () => {
    const cashierId = await nextCashierId();
    await expect(
      cashierService.openTill(pool, { branchId, cashierId, openingBalancePesewas: 999999999, businessDate: '2026-01-05', openedBy: maker })
    ).rejects.toThrow(/vault balance/);
  });

  test('a till open posts a balanced Dr Cash in Hand / Cr Vault entry, and a cashier cannot have two open tills', async () => {
    await fundVault(1000000, '2026-01-01');
    const cashierId = await nextCashierId();

    const till = await cashierService.openTill(pool, {
      branchId,
      cashierId,
      openingBalancePesewas: 200000,
      businessDate: '2026-01-05',
      openedBy: maker,
    });
    expect(till.status).toBe('open');
    expect(till.journalEntry.lines).toHaveLength(2);
    const cashLine = till.journalEntry.lines.find((l) => Number(l.account_id) === Number(glAccounts.cash_in_hand_account_id));
    const vaultLine = till.journalEntry.lines.find((l) => Number(l.account_id) === Number(glAccounts.vault_account_id));
    expect(Number(cashLine.debit_pesewas)).toBe(200000);
    expect(Number(vaultLine.credit_pesewas)).toBe(200000);

    await expect(
      cashierService.openTill(pool, { branchId, cashierId, openingBalancePesewas: 1000, businessDate: '2026-01-05', openedBy: maker })
    ).rejects.toThrow(/already has an open till/);

    // Close it so later close-out tests (which require NO open tills
    // anywhere in the branch) aren't blocked by this one.
    await cashierService.closeTill(pool, { tillId: till.id, closingBalancePesewas: 200000, closedBy: maker });
  });

  test('cash-back below the (default zero) threshold still requires approval, and pays out once approved', async () => {
    const cashierId = await nextCashierId();
    const till = await cashierService.openTill(pool, {
      branchId,
      cashierId,
      openingBalancePesewas: 100000,
      businessDate: '2026-01-06',
      openedBy: maker,
    });

    const requested = await cashierService.requestCashBack(pool, { tillId: till.id, amountPesewas: 20000, requestedBy: maker });
    expect(requested.paidOut).toBe(false);
    expect(requested.cashBackRequest.status).toBe('pending');

    await expect(
      cashierService.settleApprovedCashBack(pool, { cashBackRequestId: requested.cashBackRequest.id, paidBy: maker })
    ).rejects.toThrow(cashierService.CashierConflictError);

    await decideAs(requested.approvalRequest.id, checker);
    const settled = await cashierService.settleApprovedCashBack(pool, {
      cashBackRequestId: requested.cashBackRequest.id,
      paidBy: maker,
    });
    expect(settled.paidOut).toBe(true);
    expect(settled.cashBackRequest.status).toBe('paid');

    await cashierService.closeTill(pool, { tillId: till.id, closingBalancePesewas: 120000, closedBy: maker });
  });

  test('closing a till computes the expected balance from opening float + paid cash-back, and records any variance without blocking', async () => {
    const cashierId = await nextCashierId();
    const till = await cashierService.openTill(pool, {
      branchId,
      cashierId,
      openingBalancePesewas: 150000,
      businessDate: '2026-01-07',
      openedBy: maker,
    });

    const requested = await cashierService.requestCashBack(pool, { tillId: till.id, amountPesewas: 30000, requestedBy: maker });
    await decideAs(requested.approvalRequest.id, checker);
    await cashierService.settleApprovedCashBack(pool, { cashBackRequestId: requested.cashBackRequest.id, paidBy: maker });

    // Expected: 150000 + 30000 = 180000. Cashier actually counts 175000 -> a 5000 shortage.
    const closed = await cashierService.closeTill(pool, { tillId: till.id, closingBalancePesewas: 175000, closedBy: maker });
    expect(closed.status).toBe('closed');
    expect(Number(closed.expected_closing_balance_pesewas)).toBe(180000);
    expect(Number(closed.variance_pesewas)).toBe(-5000);
    const vaultLine = closed.journalEntry.lines.find((l) => Number(l.account_id) === Number(glAccounts.vault_account_id));
    const cashLine = closed.journalEntry.lines.find((l) => Number(l.account_id) === Number(glAccounts.cash_in_hand_account_id));
    expect(Number(vaultLine.debit_pesewas)).toBe(175000);
    expect(Number(cashLine.credit_pesewas)).toBe(175000);

    await expect(
      cashierService.closeTill(pool, { tillId: till.id, closingBalancePesewas: 1, closedBy: maker })
    ).rejects.toThrow(/not open/);
  });

  test('a reversal request always requires maker-checker, executing it swaps the original entry\'s lines, and it cannot be reversed twice', async () => {
    const cashierId = await nextCashierId();
    const till = await cashierService.openTill(pool, {
      branchId,
      cashierId,
      openingBalancePesewas: 50000,
      businessDate: '2026-01-08',
      openedBy: maker,
    });
    const originalEntryId = till.journalEntry.id;

    const { reversal, approvalRequest } = await cashierService.requestReversal(pool, {
      originalJournalEntryId: originalEntryId,
      reasonCode: 'wrong_amount',
      notes: 'test',
      requestedBy: maker,
    });
    expect(reversal.status).toBe('pending');

    await expect(
      cashierService.executeApprovedReversal(pool, { reversalId: reversal.id, executedBy: maker })
    ).rejects.toThrow(cashierService.CashierConflictError);

    await decideAs(approvalRequest.id, checker);
    const executed = await cashierService.executeApprovedReversal(pool, { reversalId: reversal.id, executedBy: maker });
    expect(executed.reversal.status).toBe('reversed');
    expect(executed.reversalEntry.reverses_entry_id).toBe(originalEntryId);

    const original = till.journalEntry.lines;
    const reversed = executed.reversalEntry.lines;
    // Every line's debit/credit is swapped relative to the original.
    for (const origLine of original) {
      const swapped = reversed.find((l) => Number(l.account_id) === Number(origLine.account_id));
      expect(Number(swapped.debit_pesewas)).toBe(Number(origLine.credit_pesewas));
      expect(Number(swapped.credit_pesewas)).toBe(Number(origLine.debit_pesewas));
    }

    // Rejected either way: the original entry's own status is now
    // 'reversed' (caught first), which is itself proof no second reversal
    // is possible — the dedicated "already has a reversal" check on
    // transaction_reversals is defense in depth for the same invariant.
    await expect(
      cashierService.requestReversal(pool, { originalJournalEntryId: originalEntryId, reasonCode: 'again', requestedBy: maker })
    ).rejects.toThrow(cashierService.CashierConflictError);

    // The reversal already returned the float to the vault at the GL
    // level; close the till at 0 so later close-out tests (which require
    // no open tills anywhere in the branch) aren't blocked by it.
    await cashierService.closeTill(pool, { tillId: till.id, closingBalancePesewas: 0, closedBy: maker });
  });

  test('day close-out is blocked while any till in the branch is open, and lists which ones', async () => {
    const cashierId = await nextCashierId();
    const till = await cashierService.openTill(pool, {
      branchId,
      cashierId,
      openingBalancePesewas: 10000,
      businessDate: '2026-02-01',
      openedBy: maker,
    });

    await expect(
      cashierService.closeOutPeriod(pool, { branchId, periodType: 'day', periodStart: '2026-02-01', periodEnd: '2026-02-01', closedBy: maker })
    ).rejects.toThrow(new RegExp(`till ${till.id}`));

    await cashierService.closeTill(pool, { tillId: till.id, closingBalancePesewas: 10000, closedBy: maker });
    const snapshot = await cashierService.closeOutPeriod(pool, {
      branchId,
      periodType: 'day',
      periodStart: '2026-02-01',
      periodEnd: '2026-02-01',
      closedBy: maker,
    });
    expect(snapshot.locked).toBe(true);
    expect(snapshot.gl_period_id).toBeNull(); // 'day' has no gl_periods equivalent

    await expect(
      cashierService.closeOutPeriod(pool, { branchId, periodType: 'day', periodStart: '2026-02-01', periodEnd: '2026-02-01', closedBy: maker })
    ).rejects.toThrow(/already has a day close-out/);
  });

  test("a locked day blocks opening a till dated into it, even from a different branch's cashier", async () => {
    await expect(
      cashierService.openTill(pool, {
        branchId,
        cashierId: await nextCashierId(),
        openingBalancePesewas: 0,
        businessDate: '2026-02-01',
        openedBy: maker,
      })
    ).rejects.toThrow(/is already locked/);
  });

  test('month close-out creates and locks a real gl_periods row, which then blocks ordinary postings into that month until a prior-period adjustment', async () => {
    const snapshot = await cashierService.closeOutPeriod(pool, {
      branchId,
      periodType: 'month',
      periodStart: '2026-01-01',
      periodEnd: '2026-01-31',
      closedBy: maker,
    });
    expect(snapshot.gl_period_id).not.toBeNull();

    await expect(
      glPosting.postJournalEntry(pool, {
        branchId,
        reference: 'SHOULD-BE-BLOCKED',
        entryDate: '2026-01-15',
        sourceModule: 'manual_jv',
        createdBy: maker,
        lines: [
          { accountId: glAccounts.vault_account_id, debitPesewas: 100, branchId },
          { accountId: glAccounts.cash_in_hand_account_id, creditPesewas: 100, branchId },
        ],
      })
    ).rejects.toThrow(glPosting.PeriodLockedError);

    const { adjustment, approvalRequest } = await glPosting.requestPriorPeriodAdjustment(pool, {
      branchId,
      entryDate: '2026-01-15',
      description: 'Backdated correction',
      lines: [
        { accountId: glAccounts.vault_account_id, debitPesewas: 100 },
        { accountId: glAccounts.cash_in_hand_account_id, creditPesewas: 100 },
      ],
      requestedBy: maker,
    });
    expect(adjustment.status).toBe('pending');

    await expect(
      glPosting.postApprovedPriorPeriodAdjustment(pool, { adjustmentId: adjustment.id, postedBy: maker })
    ).rejects.toThrow(glPosting.GlPostingConflictError);

    await decideAs(approvalRequest.id, checker);
    const posted = await glPosting.postApprovedPriorPeriodAdjustment(pool, { adjustmentId: adjustment.id, postedBy: maker });
    expect(posted.adjustment.status).toBe('posted');
    expect(posted.journalEntry.entry_type).toBe('prior_period_adjustment');
  });

  test('branch and consolidated cash position reflect the vault + cash-in-hand balances and open tills', async () => {
    const position = await cashierService.getBranchCashPosition(pool, branchId);
    expect(position.totalCashPositionPesewas).toBe(position.cashInHandBalancePesewas + position.vaultBalancePesewas);

    const consolidated = await cashierService.getConsolidatedCashPosition(pool);
    const thisBranch = consolidated.branches.find((b) => b.branchId === Number(branchId));
    expect(thisBranch.cashInHandBalancePesewas).toBe(position.cashInHandBalancePesewas);
    expect(consolidated.totals.totalCashPositionPesewas).toBeGreaterThanOrEqual(position.totalCashPositionPesewas);
  });
});
