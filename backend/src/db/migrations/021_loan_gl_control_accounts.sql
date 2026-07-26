-- Module 3: new org-wide GL control accounts for loan accounting, and the
-- per-branch sub-accounts that post against them. Extends
-- branch_gl_accounts (Module 1) rather than creating a parallel table —
-- same convention as extending `branches` itself for new fields.
--
--   1100  Loans Receivable    (asset)   — principal owed to us by borrowers
--   4010  Loan Interest Income (income)
--   4020  Loan Fee Income      (income)
--   5100  Loan Loss Expense    (expense) — write-offs

INSERT INTO gl_accounts (code, name, account_type) VALUES
  ('1100', 'Loans Receivable', 'asset'),
  ('4010', 'Loan Interest Income', 'income'),
  ('4020', 'Loan Fee Income', 'income'),
  ('5100', 'Loan Loss Expense', 'expense');

ALTER TABLE branch_gl_accounts
  ADD COLUMN loans_receivable_account_id BIGINT REFERENCES gl_accounts(id),
  ADD COLUMN loan_interest_income_account_id BIGINT REFERENCES gl_accounts(id),
  ADD COLUMN loan_fee_income_account_id BIGINT REFERENCES gl_accounts(id),
  ADD COLUMN loan_loss_expense_account_id BIGINT REFERENCES gl_accounts(id);

-- Backfill for every existing branch. Branches created via
-- branchService.createBranch() (Module 1) already have a
-- branch_gl_accounts row, so they just get the 4 new sub-accounts
-- attached. HQ is a special case discovered here: it was seeded directly
-- by migration 001 (INSERT INTO branches ...), bypassing createBranch()
-- entirely, so it never got a branch_gl_accounts row OR its Module 1
-- sub-accounts (cash-in-hand/vault/income/expense) in the first place —
-- this backfill fixes that gap for HQ too, not just the Module 3 columns,
-- so every branch ends up complete. branchService.createBranch() is
-- updated in this same migration set to create the 4 new sub-accounts
-- going forward for any newly-created branch.
DO $$
DECLARE
  branch_row RECORD;
  control_row RECORD;
  new_account_id BIGINT;
  cash_id BIGINT;
  vault_id BIGINT;
  income_id BIGINT;
  expense_id BIGINT;
  loans_receivable_id BIGINT;
  loan_interest_income_id BIGINT;
  loan_fee_income_id BIGINT;
  loan_loss_expense_id BIGINT;
  existing_branch_id BIGINT;
BEGIN
  FOR branch_row IN SELECT id, code, name FROM branches LOOP
    SELECT branch_id INTO existing_branch_id FROM branch_gl_accounts WHERE branch_id = branch_row.id;

    loans_receivable_id := NULL;
    loan_interest_income_id := NULL;
    loan_fee_income_id := NULL;
    loan_loss_expense_id := NULL;

    FOR control_row IN
      SELECT id AS control_id, code, name, account_type FROM gl_accounts
      WHERE code IN ('1100', '4010', '4020', '5100') AND branch_id IS NULL
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

      IF control_row.code = '1100' THEN loans_receivable_id := new_account_id;
      ELSIF control_row.code = '4010' THEN loan_interest_income_id := new_account_id;
      ELSIF control_row.code = '4020' THEN loan_fee_income_id := new_account_id;
      ELSIF control_row.code = '5100' THEN loan_loss_expense_id := new_account_id;
      END IF;
    END LOOP;

    IF existing_branch_id IS NOT NULL THEN
      UPDATE branch_gl_accounts
        SET loans_receivable_account_id = loans_receivable_id,
            loan_interest_income_account_id = loan_interest_income_id,
            loan_fee_income_account_id = loan_fee_income_id,
            loan_loss_expense_account_id = loan_loss_expense_id
      WHERE branch_id = branch_row.id;
    ELSE
      cash_id := NULL;
      vault_id := NULL;
      income_id := NULL;
      expense_id := NULL;

      FOR control_row IN
        SELECT id AS control_id, code, name, account_type FROM gl_accounts
        WHERE code IN ('1000', '1010', '4000', '5000') AND branch_id IS NULL
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

        IF control_row.code = '1000' THEN cash_id := new_account_id;
        ELSIF control_row.code = '1010' THEN vault_id := new_account_id;
        ELSIF control_row.code = '4000' THEN income_id := new_account_id;
        ELSIF control_row.code = '5000' THEN expense_id := new_account_id;
        END IF;
      END LOOP;

      INSERT INTO branch_gl_accounts
        (branch_id, cash_in_hand_account_id, vault_account_id, income_account_id, expense_account_id,
         loans_receivable_account_id, loan_interest_income_account_id, loan_fee_income_account_id, loan_loss_expense_account_id)
      VALUES (
        branch_row.id, cash_id, vault_id, income_id, expense_id,
        loans_receivable_id, loan_interest_income_id, loan_fee_income_id, loan_loss_expense_id
      );

      INSERT INTO branch_vault_configs (branch_id, opening_float_pesewas, daily_cash_limit_pesewas)
      SELECT branch_row.id, 0, 0
      WHERE NOT EXISTS (SELECT 1 FROM branch_vault_configs WHERE branch_id = branch_row.id);
    END IF;
  END LOOP;
END $$;

ALTER TABLE branch_gl_accounts
  ALTER COLUMN cash_in_hand_account_id SET NOT NULL,
  ALTER COLUMN vault_account_id SET NOT NULL,
  ALTER COLUMN income_account_id SET NOT NULL,
  ALTER COLUMN expense_account_id SET NOT NULL,
  ALTER COLUMN loans_receivable_account_id SET NOT NULL,
  ALTER COLUMN loan_interest_income_account_id SET NOT NULL,
  ALTER COLUMN loan_fee_income_account_id SET NOT NULL,
  ALTER COLUMN loan_loss_expense_account_id SET NOT NULL;
