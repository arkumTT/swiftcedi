'use strict';

// Exercises Module 7's own additions (glService.js) against a real
// Postgres instance: chart-of-accounts CRUD (including the "immutable once
// posted, can't deactivate with a balance" rules), the financial statement
// reports built on getAccountRollup, the manual-JV maker-checker workflow,
// and the bank reconciliation module. The underlying posting primitives
// (postJournalEntry, balance normalization) already have their own
// dedicated unit tests (tests/unit/glPosting.test.js) — this file is about
// glService.js's own logic layered on top. Requires TEST_DATABASE_URL —
// see backend/README.md.

require('dotenv').config();
const { Pool } = require('pg');
const { execFileSync } = require('child_process');
const path = require('path');

const glService = require('../../src/modules/gl/glService');
const glPosting = require('../../src/shared/glPosting');
const branchService = require('../../src/modules/branch/branchService');
const approvalWorkflow = require('../../src/shared/approvalWorkflow');

const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

describeIfDb('Module 7: GL, accounting & financial reporting', () => {
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

    // bank_accounts, gl_manual_entries, and dashboard_widget_configs are
    // deleted explicitly (not just relied on via CASCADE) since none of
    // them reference gl_journal_entries/lines, so none would be touched
    // by the journal TRUNCATE CASCADE below — dashboard_widget_configs is
    // only ever populated by analyticsModule.test.js, but every suite's
    // own `DELETE FROM users` needs it gone first regardless of which
    // suite created it, since it references users directly.
    await pool.query('DELETE FROM bank_statement_lines');
    await pool.query('DELETE FROM bank_accounts');
    await pool.query('DELETE FROM gl_manual_entries');
    await pool.query('DELETE FROM dashboard_widget_configs');
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
    // Org-wide (branch_id IS NULL) accounts this suite creates aren't
    // touched by the scoped delete above (that's only for branch-scoped
    // rows) and the test DB persists across runs, so a prior run's
    // 'TEST-9000' would otherwise collide with this run's on the UNIQUE
    // code constraint.
    await pool.query("DELETE FROM gl_accounts WHERE code LIKE 'TEST-%' AND branch_id IS NULL");
    await pool.query("DELETE FROM branches WHERE code <> 'HQ'");
    await pool.query('DELETE FROM branch_clusters');
    await pool.query('DELETE FROM branch_regions');

    branchService.registerBranchExecutionHandlers();
    glService.registerGlModuleExecutionHandlers();
    glPosting.registerGlExecutionHandlers();

    const { rows: roleRows } = await pool.query("SELECT id FROM roles WHERE name = 'owner'");
    ownerRoleId = roleRows[0].id;

    maker = await createTestUser('gl-maker@test.local');
    checker = await createTestUser('gl-checker@test.local');

    const branch = await branchService.createBranch(pool, { code: 'GL-01', name: 'GL Test Branch', createdBy: maker });
    branchId = branch.id;
    glAccounts = branch.glAccounts;
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

  /** Posts a balanced Dr cash-in-hand / Cr income entry directly, same as a real cash deposit would. */
  async function postCashIncome(amountPesewas, entryDate = '2026-02-01') {
    return glPosting.postJournalEntry(pool, {
      branchId,
      reference: `TEST-${Date.now()}-${Math.random()}`,
      entryDate,
      sourceModule: 'manual_jv',
      createdBy: maker,
      lines: [
        { accountId: glAccounts.cashInHand.id, debitPesewas: amountPesewas, branchId },
        { accountId: glAccounts.income.id, creditPesewas: amountPesewas, branchId },
      ],
    });
  }

  // --- Chart of accounts ------------------------------------------------------

  describe('chart of accounts', () => {
    test('createGlAccount creates an org-wide account and audit-logs it', async () => {
      const account = await glService.createGlAccount(pool, {
        code: 'TEST-9000',
        name: 'Test Suspense',
        accountType: 'asset',
        createdBy: maker,
        actorBranchId: branchId,
      });
      expect(account.branch_id).toBeNull();
      expect(account.status).toBe('active');

      const { rows } = await pool.query(
        "SELECT * FROM audit_log WHERE action = 'gl.account_created' AND entity_id = $1",
        [account.id]
      );
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].branch_id)).toBe(Number(branchId));
    });

    test('createGlAccount rejects an invalid accountType', async () => {
      await expect(
        glService.createGlAccount(pool, {
          code: 'TEST-9001',
          name: 'Bad Type',
          accountType: 'bogus',
          createdBy: maker,
          actorBranchId: branchId,
        })
      ).rejects.toThrow(glService.GlValidationError);
    });

    test('code/accountType become immutable once the account has posted GL activity, but name/status stay editable', async () => {
      const account = await glService.createGlAccount(pool, {
        code: 'TEST-9010',
        name: 'Test Immutable',
        accountType: 'expense',
        branchId,
        createdBy: maker,
        actorBranchId: branchId,
      });

      const renamed = await glService.updateGlAccount(pool, {
        accountId: account.id,
        updatedBy: maker,
        actorBranchId: branchId,
        fields: { name: 'Renamed' },
      });
      expect(renamed.name).toBe('Renamed');

      await glPosting.postJournalEntry(pool, {
        branchId,
        reference: `TEST-ACTIVITY-${Date.now()}`,
        entryDate: '2026-02-01',
        sourceModule: 'manual_jv',
        createdBy: maker,
        lines: [
          { accountId: account.id, debitPesewas: 500, branchId },
          { accountId: glAccounts.cashInHand.id, creditPesewas: 500, branchId },
        ],
      });

      await expect(
        glService.updateGlAccount(pool, {
          accountId: account.id,
          updatedBy: maker,
          actorBranchId: branchId,
          fields: { code: 'TEST-9010-B' },
        })
      ).rejects.toThrow(glService.GlConflictError);
    });

    test('deactivating an account with a non-zero balance is rejected, but a zero-balance account can be deactivated', async () => {
      const funded = await glService.createGlAccount(pool, {
        code: 'TEST-9020',
        name: 'Funded Account',
        accountType: 'expense',
        branchId,
        createdBy: maker,
        actorBranchId: branchId,
      });
      await glPosting.postJournalEntry(pool, {
        branchId,
        reference: `TEST-FUNDED-${Date.now()}`,
        entryDate: '2026-02-01',
        sourceModule: 'manual_jv',
        createdBy: maker,
        lines: [
          { accountId: funded.id, debitPesewas: 700, branchId },
          { accountId: glAccounts.cashInHand.id, creditPesewas: 700, branchId },
        ],
      });
      await expect(
        glService.updateGlAccount(pool, {
          accountId: funded.id,
          updatedBy: maker,
          actorBranchId: branchId,
          fields: { status: 'inactive' },
        })
      ).rejects.toThrow(glService.GlConflictError);

      const empty = await glService.createGlAccount(pool, {
        code: 'TEST-9030',
        name: 'Empty Account',
        accountType: 'expense',
        branchId,
        createdBy: maker,
        actorBranchId: branchId,
      });
      const deactivated = await glService.updateGlAccount(pool, {
        accountId: empty.id,
        updatedBy: maker,
        actorBranchId: branchId,
        fields: { status: 'inactive' },
      });
      expect(deactivated.status).toBe('inactive');
    });
  });

  // --- Financial statements ---------------------------------------------------

  describe('financial statements', () => {
    test('trial balance is balanced and daily balance summary matches it for the same date', async () => {
      await postCashIncome(150000, '2026-03-01');

      const trialBalance = await glService.getTrialBalance(pool, { asOfDate: '2026-03-01', branchId });
      expect(trialBalance.balanced).toBe(true);
      expect(trialBalance.totalDebitPesewas).toBe(trialBalance.totalCreditPesewas);

      const dailySummary = await glService.getDailyBalanceSummary(pool, { date: '2026-03-01', branchId });
      expect(dailySummary.totalDebitPesewas).toBe(trialBalance.totalDebitPesewas);
    });

    test('balance sheet satisfies assets = liabilities + equity + net income', async () => {
      const balanceSheet = await glService.getBalanceSheet(pool, { asOfDate: '2026-03-01', branchId });
      expect(balanceSheet.balanced).toBe(true);
      expect(balanceSheet.totalAssetsPesewas).toBe(
        balanceSheet.totalLiabilitiesPesewas + balanceSheet.totalEquityAndNetIncomePesewas
      );
    });

    test('income statement reports period activity, not a cumulative balance', async () => {
      await postCashIncome(20000, '2026-03-15');

      const marchStatement = await glService.getIncomeStatement(pool, {
        fromDate: '2026-03-01',
        toDate: '2026-03-31',
        branchId,
      });
      expect(marchStatement.totalIncomePesewas).toBe(170000);

      const marchFirstHalf = await glService.getIncomeStatement(pool, {
        fromDate: '2026-03-01',
        toDate: '2026-03-10',
        branchId,
      });
      expect(marchFirstHalf.totalIncomePesewas).toBe(150000);
    });

    test('annual transaction report includes every posted entry for the year with its lines', async () => {
      const report = await glService.getAnnualTransactionReport(pool, { year: 2026, branchId });
      expect(report.entryCount).toBeGreaterThanOrEqual(2);
      for (const entry of report.entries) {
        expect(entry.lines.length).toBeGreaterThanOrEqual(2);
      }
    });
  });

  // --- Manual JV maker-checker -------------------------------------------------

  describe('manual JV maker-checker', () => {
    test('an unbalanced manual JV is rejected up front, before any approval request is created', async () => {
      const before = await pool.query('SELECT COUNT(*) FROM approval_requests');
      await expect(
        glService.requestManualJournalEntry(pool, {
          branchId,
          entryDate: '2026-04-01',
          description: 'Bad JV',
          lines: [
            { accountId: glAccounts.cashInHand.id, debitPesewas: 1000 },
            { accountId: glAccounts.income.id, creditPesewas: 900 },
          ],
          requestedBy: maker,
        })
      ).rejects.toThrow(glPosting.GlPostingValidationError);
      const after = await pool.query('SELECT COUNT(*) FROM approval_requests');
      expect(after.rows[0].count).toBe(before.rows[0].count);
    });

    test('a balanced manual JV requires approval before it can be posted, and posts as a standard entry once approved', async () => {
      const { entry, approvalRequest } = await glService.requestManualJournalEntry(pool, {
        branchId,
        entryDate: '2026-04-01',
        description: 'Owner capital injection',
        lines: [
          { accountId: glAccounts.cashInHand.id, debitPesewas: 300000 },
          { accountId: glAccounts.income.id, creditPesewas: 300000 },
        ],
        requestedBy: maker,
      });
      expect(entry.status).toBe('pending');

      await expect(
        glService.postApprovedManualJournalEntry(pool, { entryId: entry.id, postedBy: checker })
      ).rejects.toThrow(glService.GlConflictError);

      await decideAs(approvalRequest.id, checker, 'approved');
      const { rows: approvedRows } = await pool.query('SELECT * FROM gl_manual_entries WHERE id = $1', [entry.id]);
      expect(approvedRows[0].status).toBe('approved');

      const { entry: postedEntry, journalEntry } = await glService.postApprovedManualJournalEntry(pool, {
        entryId: entry.id,
        postedBy: checker,
      });
      expect(postedEntry.status).toBe('posted');
      expect(Number(postedEntry.journal_entry_id)).toBe(Number(journalEntry.id));
      expect(journalEntry.lines).toHaveLength(2);
    });

    test('the requester cannot approve their own manual JV', async () => {
      const { approvalRequest } = await glService.requestManualJournalEntry(pool, {
        branchId,
        entryDate: '2026-04-02',
        description: 'Self-approval attempt',
        lines: [
          { accountId: glAccounts.cashInHand.id, debitPesewas: 1000 },
          { accountId: glAccounts.income.id, creditPesewas: 1000 },
        ],
        requestedBy: maker,
      });
      await expect(decideAs(approvalRequest.id, maker, 'approved')).rejects.toThrow(
        approvalWorkflow.MakerCheckerViolationError
      );
    });
  });

  // --- Bank reconciliation -----------------------------------------------------

  describe('bank reconciliation', () => {
    let bankGlAccount;
    let bankAccount;

    beforeAll(async () => {
      bankGlAccount = await glService.createGlAccount(pool, {
        code: 'TEST-1040',
        name: 'Test Operating Bank Account',
        accountType: 'asset',
        branchId,
        createdBy: maker,
        actorBranchId: branchId,
      });
      bankAccount = await glService.createBankAccount(pool, {
        glAccountId: bankGlAccount.id,
        branchId,
        bankName: 'Ghana Commercial Bank',
        accountNumber: '1234567890',
        createdBy: maker,
        actorBranchId: branchId,
      });
    });

    test('createBankAccount rejects a non-asset GL account', async () => {
      await expect(
        glService.createBankAccount(pool, {
          glAccountId: glAccounts.income.id,
          branchId,
          bankName: 'Ghana Commercial Bank',
          accountNumber: '000',
          createdBy: maker,
          actorBranchId: branchId,
        })
      ).rejects.toThrow(glService.GlValidationError);
    });

    test('a fully matched period reconciles exactly, and outstanding items are classified on the correct side', async () => {
      const depositEntry = await glPosting.postJournalEntry(pool, {
        branchId,
        reference: `TEST-BANK-DEPOSIT-${Date.now()}`,
        entryDate: '2026-05-01',
        sourceModule: 'manual_jv',
        createdBy: maker,
        lines: [
          { accountId: bankGlAccount.id, debitPesewas: 500000, branchId },
          { accountId: glAccounts.cashInHand.id, creditPesewas: 500000, branchId },
        ],
      });
      const bankLine = depositEntry.lines.find((l) => Number(l.account_id) === Number(bankGlAccount.id));

      const [statementLine] = await glService.importStatementLines(pool, {
        bankAccountId: bankAccount.id,
        lines: [{ statementDate: '2026-05-02', description: 'Cash deposit', amountPesewas: 500000 }],
        uploadedBy: maker,
        actorBranchId: branchId,
      });

      const preMatch = await glService.getBankReconciliation(pool, { bankAccountId: bankAccount.id, asOfDate: '2026-05-31' });
      expect(preMatch.reconciled).toBe(false);
      expect(preMatch.outstandingOnStatementNotInGl).toHaveLength(1);
      expect(preMatch.outstandingInGlNotOnStatement).toHaveLength(1);

      await glService.matchStatementLine(pool, {
        statementLineId: statementLine.id,
        journalLineId: bankLine.id,
        matchedBy: maker,
        actorBranchId: branchId,
      });

      const postMatch = await glService.getBankReconciliation(pool, { bankAccountId: bankAccount.id, asOfDate: '2026-05-31' });
      expect(postMatch.reconciled).toBe(true);
      expect(postMatch.outstandingOnStatementNotInGl).toHaveLength(0);
      expect(postMatch.outstandingInGlNotOnStatement).toHaveLength(0);
      expect(postMatch.glBalancePesewas).toBe(postMatch.statementBalancePesewas);
    });

    test('matching rejects a journal line whose amount does not equal the statement line amount', async () => {
      const mismatchedEntry = await glPosting.postJournalEntry(pool, {
        branchId,
        reference: `TEST-BANK-MISMATCH-${Date.now()}`,
        entryDate: '2026-05-10',
        sourceModule: 'manual_jv',
        createdBy: maker,
        lines: [
          { accountId: bankGlAccount.id, debitPesewas: 100, branchId },
          { accountId: glAccounts.cashInHand.id, creditPesewas: 100, branchId },
        ],
      });
      const mismatchedLine = mismatchedEntry.lines.find((l) => Number(l.account_id) === Number(bankGlAccount.id));

      const [statementLine] = await glService.importStatementLines(pool, {
        bankAccountId: bankAccount.id,
        lines: [{ statementDate: '2026-05-10', description: 'Small fee', amountPesewas: 200 }],
        uploadedBy: maker,
        actorBranchId: branchId,
      });

      await expect(
        glService.matchStatementLine(pool, {
          statementLineId: statementLine.id,
          journalLineId: mismatchedLine.id,
          matchedBy: maker,
          actorBranchId: branchId,
        })
      ).rejects.toThrow(glService.GlValidationError);
    });

    test('a statement line cannot be matched twice', async () => {
      const entryA = await glPosting.postJournalEntry(pool, {
        branchId,
        reference: `TEST-BANK-DOUBLEMATCH-A-${Date.now()}`,
        entryDate: '2026-05-15',
        sourceModule: 'manual_jv',
        createdBy: maker,
        lines: [
          { accountId: bankGlAccount.id, debitPesewas: 300, branchId },
          { accountId: glAccounts.cashInHand.id, creditPesewas: 300, branchId },
        ],
      });
      const lineA = entryA.lines.find((l) => Number(l.account_id) === Number(bankGlAccount.id));

      const [statementLine] = await glService.importStatementLines(pool, {
        bankAccountId: bankAccount.id,
        lines: [{ statementDate: '2026-05-15', description: 'Double match attempt', amountPesewas: 300 }],
        uploadedBy: maker,
        actorBranchId: branchId,
      });

      await glService.matchStatementLine(pool, {
        statementLineId: statementLine.id,
        journalLineId: lineA.id,
        matchedBy: maker,
        actorBranchId: branchId,
      });

      await expect(
        glService.matchStatementLine(pool, {
          statementLineId: statementLine.id,
          journalLineId: lineA.id,
          matchedBy: maker,
          actorBranchId: branchId,
        })
      ).rejects.toThrow(glService.GlConflictError);
    });
  });
});
