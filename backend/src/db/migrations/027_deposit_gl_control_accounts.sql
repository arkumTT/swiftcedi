-- Module 4: deposit-side GL control accounts. Follows the recipe recorded
-- in Decisions_Log.md ("How to add a control account"): insert controls,
-- add branch_gl_accounts columns, backfill sub-accounts for every existing
-- branch, then SET NOT NULL. branchService.CONTROL_ACCOUNT_CODES and
-- createBranch() are updated in the same change set so NEW branches get
-- these too.
--
--   1030  Cash with Agents          (asset)     — cash collected in the field, not yet banked
--   2000  Customer Deposits         (liability) — savings balances owed to customers
--   2010  Susu Deposits             (liability) — susu balances owed to customers
--   2020  Agent Commission Payable  (liability) — commission accrued, not yet paid
--   4030  Savings Fee Income        (income)    — maintenance/withdrawal/min-balance charges
--   5200  Agent Commission Expense  (expense)
--
-- 1030 is the key to the Module 10 hand-off: susu collections debit it
-- (cash is with the agent), and remittance moves it to 1000 Cash in Hand.
-- Its balance IS "cash agents are currently holding" — the figure Module
-- 10's end-of-day agent reconciliation reconciles against. See
-- Decisions_Log.md.

INSERT INTO gl_accounts (code, name, account_type) VALUES
  ('1030', 'Cash with Agents', 'asset'),
  ('2000', 'Customer Deposits', 'liability'),
  ('2010', 'Susu Deposits', 'liability'),
  ('2020', 'Agent Commission Payable', 'liability'),
  ('4030', 'Savings Fee Income', 'income'),
  ('5200', 'Agent Commission Expense', 'expense');

ALTER TABLE branch_gl_accounts
  ADD COLUMN cash_with_agents_account_id BIGINT REFERENCES gl_accounts(id),
  ADD COLUMN customer_deposits_account_id BIGINT REFERENCES gl_accounts(id),
  ADD COLUMN susu_deposits_account_id BIGINT REFERENCES gl_accounts(id),
  ADD COLUMN agent_commission_payable_account_id BIGINT REFERENCES gl_accounts(id),
  ADD COLUMN savings_fee_income_account_id BIGINT REFERENCES gl_accounts(id),
  ADD COLUMN agent_commission_expense_account_id BIGINT REFERENCES gl_accounts(id);

DO $$
DECLARE
  branch_row RECORD;
  control_row RECORD;
  new_account_id BIGINT;
  col_name TEXT;
BEGIN
  FOR branch_row IN SELECT id, code, name FROM branches LOOP
    FOR control_row IN
      SELECT id AS control_id, code, name, account_type FROM gl_accounts
      WHERE code IN ('1030', '2000', '2010', '2020', '4030', '5200') AND branch_id IS NULL
    LOOP
      INSERT INTO gl_accounts (code, name, account_type, branch_id, parent_account_id)
      VALUES (
        control_row.code || '.' || branch_row.code,
        control_row.name || ' - ' || branch_row.name,
        control_row.account_type,
        branch_row.id,
        control_row.control_id
      )
      RETURNING id INTO new_account_id;

      col_name := CASE control_row.code
        WHEN '1030' THEN 'cash_with_agents_account_id'
        WHEN '2000' THEN 'customer_deposits_account_id'
        WHEN '2010' THEN 'susu_deposits_account_id'
        WHEN '2020' THEN 'agent_commission_payable_account_id'
        WHEN '4030' THEN 'savings_fee_income_account_id'
        WHEN '5200' THEN 'agent_commission_expense_account_id'
      END;

      EXECUTE format('UPDATE branch_gl_accounts SET %I = $1 WHERE branch_id = $2', col_name)
        USING new_account_id, branch_row.id;
    END LOOP;
  END LOOP;
END $$;

ALTER TABLE branch_gl_accounts
  ALTER COLUMN cash_with_agents_account_id SET NOT NULL,
  ALTER COLUMN customer_deposits_account_id SET NOT NULL,
  ALTER COLUMN susu_deposits_account_id SET NOT NULL,
  ALTER COLUMN agent_commission_payable_account_id SET NOT NULL,
  ALTER COLUMN savings_fee_income_account_id SET NOT NULL,
  ALTER COLUMN agent_commission_expense_account_id SET NOT NULL;
