-- Module 3 (closing the Open Question in Decisions_Log.md): overdraft loans
-- as an actual revolving facility against a savings account, rather than an
-- unlimited/unattached bypass of the balance check.
--
-- Design: `loans.principal_pesewas` already means "amount" for individual/
-- group loans; for loan_type = 'overdraft' it is repurposed to mean "the
-- approved overdraft LIMIT" instead — no new column needed for that. What
-- IS new is the link from the loan to the specific savings account the
-- facility is attached to, and the real numeric limit that account is
-- allowed to go negative by (previously: an unconditional bypass of the
-- balance check for ANY account on an allows_overdraft product — a bug,
-- since nothing tied that bypass to an actual approved amount).
--
-- No schedule is generated and nothing posts to GL at overdraft
-- "disbursement" (see loanService.activateOverdraft) — nothing is owed
-- until the customer actually draws against the account, and drawing
-- happens through the EXISTING savings withdrawal path once the account's
-- real limit is set. The only thing that posts to GL for an overdraft is
-- periodic interest accrual (Dr Customer Deposits / Cr Loan Interest
-- Income — same direction as an ordinary withdrawal/fee, since Customer
-- Deposits is a liability and interest owed further reduces what's owed
-- back to the customer), tracked here in overdraft_interest_accruals.

ALTER TABLE loans
  ADD COLUMN overdraft_savings_account_id BIGINT REFERENCES savings_accounts(id);

ALTER TABLE loans
  ADD CONSTRAINT loans_overdraft_account_chk CHECK (
    (loan_type = 'overdraft' AND overdraft_savings_account_id IS NOT NULL) OR
    (loan_type <> 'overdraft' AND overdraft_savings_account_id IS NULL)
  );

-- The real, numeric overdraft ceiling for THIS account. Zero (the default)
-- means "no active facility" — assessWithdrawal/applyMovement floor the
-- account at -overdraft_limit_pesewas instead of an unconditional bypass.
ALTER TABLE savings_accounts
  ADD COLUMN overdraft_limit_pesewas BIGINT NOT NULL DEFAULT 0;

ALTER TABLE savings_accounts
  ADD CONSTRAINT savings_accounts_overdraft_limit_chk CHECK (overdraft_limit_pesewas >= 0);

ALTER TABLE savings_transactions
  DROP CONSTRAINT savings_transactions_type_chk;

ALTER TABLE savings_transactions
  ADD CONSTRAINT savings_transactions_type_chk CHECK (
    txn_type IN ('deposit', 'withdrawal', 'maintenance_fee', 'withdrawal_fee', 'min_balance_charge',
                 'standing_order_out', 'standing_order_in', 'susu_payout', 'overdraft_interest', 'overdraft_writeoff')
  );

-- Audit trail of every overdraft interest accrual. Unlike loan_repayments/
-- savings_transactions, this needs no two-phase journal_entry_id stamp —
-- it's written AFTER savingsService.applyMovement (which already posted the
-- GL entry and stamped its own savings_transactions row) returns, so every
-- column is known at insert time. Append-only for the same reason every
-- other financial ledger table is: a correction is a new accrual reversal,
-- never an edit of history. The UNIQUE(loan_id, accrual_date) constraint is
-- a deliberate guard against double-accruing interest for the same loan on
-- the same day.
CREATE TABLE overdraft_interest_accruals (
  id BIGSERIAL PRIMARY KEY,
  loan_id BIGINT NOT NULL REFERENCES loans(id),
  savings_account_id BIGINT NOT NULL REFERENCES savings_accounts(id),
  savings_transaction_id BIGINT NOT NULL REFERENCES savings_transactions(id),
  accrual_date DATE NOT NULL,
  drawn_balance_pesewas BIGINT NOT NULL,
  annual_interest_rate_bps INT NOT NULL,
  interest_pesewas BIGINT NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT overdraft_interest_accruals_drawn_chk CHECK (drawn_balance_pesewas > 0),
  CONSTRAINT overdraft_interest_accruals_interest_chk CHECK (interest_pesewas > 0),
  CONSTRAINT overdraft_interest_accruals_one_per_day UNIQUE (loan_id, accrual_date)
);

CREATE INDEX ON overdraft_interest_accruals (loan_id);
CREATE INDEX ON overdraft_interest_accruals (savings_account_id);

CREATE OR REPLACE FUNCTION prevent_overdraft_interest_accruals_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'overdraft_interest_accruals is immutable: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_overdraft_interest_accruals_immutable
  BEFORE UPDATE OR DELETE ON overdraft_interest_accruals
  FOR EACH ROW EXECUTE FUNCTION prevent_overdraft_interest_accruals_mutation();
