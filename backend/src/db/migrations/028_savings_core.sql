-- Module 4: savings products, accounts, and the immutable per-account
-- transaction ledger.
--
-- `savings_accounts.balance_pesewas` is a STORED subledger balance,
-- deliberately, even though CLAUDE.md forbids mutable running balances for
-- GL reporting. Those are different things: the GL's balances are still
-- reconstructed from gl_journal_lines (Module 7 rule, untouched). This is
-- a customer subledger, the module spec explicitly asks for it ("balance
-- in lowest currency unit"), and a teller needs an account's balance
-- without summing its whole history. It stays trustworthy because every
-- movement also writes an immutable savings_transactions row carrying
-- balance_after_pesewas, so the balance is always re-derivable and any
-- drift is detectable — see savingsService.reconcileAccount(). Module 7's
-- "GL-to-customer-account reconciliation report" is exactly this check
-- aggregated per branch.

CREATE TABLE savings_products (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  code VARCHAR(20) UNIQUE NOT NULL,
  min_balance_pesewas BIGINT NOT NULL DEFAULT 0,
  maintenance_fee_pesewas BIGINT NOT NULL DEFAULT 0,
  withdrawal_fee_pesewas BIGINT NOT NULL DEFAULT 0,
  min_balance_charge_pesewas BIGINT NOT NULL DEFAULT 0,
  -- Default withdrawal approval threshold. A branch-specific override may
  -- be configured in the shared approval_thresholds table under
  -- action_type 'savings.withdraw' — see Decisions_Log.md for the
  -- resolution order. 0 means "every withdrawal needs approval".
  withdrawal_approval_threshold_pesewas BIGINT NOT NULL DEFAULT 0,
  allows_overdraft BOOLEAN NOT NULL DEFAULT false,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT savings_products_status_chk CHECK (status IN ('active', 'inactive')),
  CONSTRAINT savings_products_nonneg_chk CHECK (
    min_balance_pesewas >= 0 AND maintenance_fee_pesewas >= 0 AND withdrawal_fee_pesewas >= 0
    AND min_balance_charge_pesewas >= 0 AND withdrawal_approval_threshold_pesewas >= 0
  )
);

CREATE TABLE savings_accounts (
  id BIGSERIAL PRIMARY KEY,
  account_no VARCHAR(30) UNIQUE NOT NULL,
  customer_id BIGINT NOT NULL REFERENCES customers(id),
  branch_id BIGINT NOT NULL REFERENCES branches(id),
  product_id BIGINT NOT NULL REFERENCES savings_products(id),
  balance_pesewas BIGINT NOT NULL DEFAULT 0,
  -- Optional per-account override of the product's charge configuration;
  -- NULL means "use the product's". Shape matches the product columns.
  charges_config JSONB,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,
  created_by BIGINT NOT NULL REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT savings_accounts_status_chk CHECK (status IN ('active', 'dormant', 'closed'))
);

CREATE INDEX ON savings_accounts (customer_id);
CREATE INDEX ON savings_accounts (branch_id);
CREATE INDEX ON savings_accounts (status);

CREATE TABLE savings_transactions (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES savings_accounts(id),
  txn_type VARCHAR(30) NOT NULL,
  -- Signed: positive credits the customer (deposit), negative debits them
  -- (withdrawal, fee). Storing the sign rather than a separate direction
  -- column means SUM(amount_pesewas) is directly comparable to
  -- balance_pesewas in reconciliation.
  amount_pesewas BIGINT NOT NULL,
  balance_after_pesewas BIGINT NOT NULL,
  description TEXT,
  journal_entry_id BIGINT REFERENCES gl_journal_entries(id),
  -- Client-supplied idempotency key (susu field collections especially).
  idempotency_key VARCHAR(80) UNIQUE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT savings_transactions_type_chk CHECK (
    txn_type IN ('deposit', 'withdrawal', 'maintenance_fee', 'withdrawal_fee', 'min_balance_charge',
                 'standing_order_out', 'standing_order_in', 'susu_payout')
  ),
  CONSTRAINT savings_transactions_amount_chk CHECK (amount_pesewas <> 0)
);

CREATE INDEX ON savings_transactions (account_id);
CREATE INDEX ON savings_transactions (created_at);

-- Append-only, same reasoning (and same one-time journal_entry_id stamp
-- exception) as loan_repayments in Module 3.
CREATE OR REPLACE FUNCTION prevent_savings_transactions_mutation() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.journal_entry_id IS NULL
     AND NEW.journal_entry_id IS NOT NULL
     AND ROW(NEW.id, NEW.account_id, NEW.txn_type, NEW.amount_pesewas, NEW.balance_after_pesewas,
             NEW.idempotency_key, NEW.created_by, NEW.created_at)
       IS NOT DISTINCT FROM
         ROW(OLD.id, OLD.account_id, OLD.txn_type, OLD.amount_pesewas, OLD.balance_after_pesewas,
             OLD.idempotency_key, OLD.created_by, OLD.created_at)
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'savings_transactions rows are immutable (%)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_savings_transactions_immutable
  BEFORE UPDATE OR DELETE ON savings_transactions
  FOR EACH ROW EXECUTE FUNCTION prevent_savings_transactions_mutation();

CREATE TABLE withdrawal_requests (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES savings_accounts(id),
  amount_pesewas BIGINT NOT NULL,
  -- True when the amount met/exceeded the effective approval threshold, so
  -- the request had to go through maker-checker before payout.
  threshold_flag BOOLEAN NOT NULL,
  approval_request_id BIGINT UNIQUE REFERENCES approval_requests(id),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  transaction_id BIGINT REFERENCES savings_transactions(id),
  requested_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT withdrawal_requests_amount_chk CHECK (amount_pesewas > 0),
  CONSTRAINT withdrawal_requests_status_chk CHECK (status IN ('pending', 'paid', 'rejected')),
  -- A request that needed approval must carry the approval record.
  CONSTRAINT withdrawal_requests_approval_chk CHECK (threshold_flag = false OR approval_request_id IS NOT NULL)
);

CREATE INDEX ON withdrawal_requests (account_id);
CREATE INDEX ON withdrawal_requests (status);
