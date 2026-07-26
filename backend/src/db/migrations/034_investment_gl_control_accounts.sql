-- Module 5: investment-side GL control accounts. Follows the recipe
-- recorded in Decisions_Log.md ("How to add a control account"): insert
-- controls, add branch_gl_accounts columns, backfill sub-accounts for
-- every existing branch, then SET NOT NULL. branchService.CONTROL_ACCOUNT_CODES
-- and createBranch() are updated in the same change set so NEW branches
-- get these too.
--
--   2030  Investment Deposits Payable  (liability) — principal + accrued
--         interest owed back to the investor. Investments are booked as a
--         LIABILITY, not equity — see Decisions_Log.md for why (the spec
--         describes a fixed-term deposit with a maturity date and
--         redemption, not an ownership/equity stake).
--   4040  Early Withdrawal Penalty Income (income) — the portion of
--         accrued interest forfeited on an early redemption.
--   5300  Investment Interest Expense (expense) — the cost of interest
--         accrued to investors. This is the mirror image of Module 3's
--         Loan Interest Income: there the institution EARNS interest from
--         borrowers, here it PAYS interest to investors.

INSERT INTO gl_accounts (code, name, account_type) VALUES
  ('2030', 'Investment Deposits Payable', 'liability'),
  ('4040', 'Early Withdrawal Penalty Income', 'income'),
  ('5300', 'Investment Interest Expense', 'expense');

ALTER TABLE branch_gl_accounts
  ADD COLUMN investment_deposits_payable_account_id BIGINT REFERENCES gl_accounts(id),
  ADD COLUMN early_withdrawal_penalty_income_account_id BIGINT REFERENCES gl_accounts(id),
  ADD COLUMN investment_interest_expense_account_id BIGINT REFERENCES gl_accounts(id);

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
      WHERE code IN ('2030', '4040', '5300') AND branch_id IS NULL
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
        WHEN '2030' THEN 'investment_deposits_payable_account_id'
        WHEN '4040' THEN 'early_withdrawal_penalty_income_account_id'
        WHEN '5300' THEN 'investment_interest_expense_account_id'
      END;

      EXECUTE format('UPDATE branch_gl_accounts SET %I = $1 WHERE branch_id = $2', col_name)
        USING new_account_id, branch_row.id;
    END LOOP;
  END LOOP;
END $$;

ALTER TABLE branch_gl_accounts
  ALTER COLUMN investment_deposits_payable_account_id SET NOT NULL,
  ALTER COLUMN early_withdrawal_penalty_income_account_id SET NOT NULL,
  ALTER COLUMN investment_interest_expense_account_id SET NOT NULL;
