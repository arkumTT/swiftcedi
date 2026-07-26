-- Module 1: seeds the org-wide GL control accounts that branch creation
-- generates branch sub-accounts under. This finalizes the chart-of-accounts
-- numbering scheme that Decisions_Log.md flagged as TBD after Module 7:
--
--   1000-1999  asset accounts     (1000 Cash in Hand, 1010 Vault Cash,
--                                  1020 Cash in Transit are org-wide controls)
--   2000-2999  liability accounts (none seeded yet — no module needs one)
--   3000-3999  equity accounts    (none seeded yet)
--   4000-4999  income accounts    (4000 Operating Income control)
--   5000-5999  expense accounts   (5000 Operating Expense control)
--
-- A branch's auto-generated sub-account code is "<control_code>.<branch_code>"
-- (e.g. "1000.NRA-01"), with parent_account_id pointing at the control row
-- and branch_id set to the branch — see branchService.js. Because of this,
-- branch codes are capped at 10 characters (validated in branchService.js)
-- so the composed code always fits gl_accounts.code's VARCHAR(20).

INSERT INTO gl_accounts (code, name, account_type) VALUES
  ('1000', 'Cash in Hand', 'asset'),
  ('1010', 'Vault Cash', 'asset'),
  ('1020', 'Cash in Transit', 'asset'),
  ('4000', 'Operating Income', 'income'),
  ('5000', 'Operating Expense', 'expense');
