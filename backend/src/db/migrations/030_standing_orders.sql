-- Module 4: standing orders (recurring transfers), executed by Module
-- 12's scheduler calling the execute-due endpoint. Every run — success or
-- failure — writes a standing_order_runs row, so a failed order is never
-- silent (business rule).

CREATE TABLE standing_orders (
  id BIGSERIAL PRIMARY KEY,
  source_account_id BIGINT NOT NULL REFERENCES savings_accounts(id),
  destination_account_id BIGINT NOT NULL REFERENCES savings_accounts(id),
  amount_pesewas BIGINT NOT NULL,
  frequency VARCHAR(20) NOT NULL,
  next_run_date DATE NOT NULL,
  end_date DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  consecutive_failures INT NOT NULL DEFAULT 0,
  -- Configurable retry policy (business rule: failures "retry on a
  -- configurable schedule", not a hardcoded one).
  retry_after_days INT NOT NULL DEFAULT 3,
  max_consecutive_failures INT NOT NULL DEFAULT 3,
  last_error TEXT,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT standing_orders_amount_chk CHECK (amount_pesewas > 0),
  CONSTRAINT standing_orders_frequency_chk CHECK (frequency IN ('daily', 'weekly', 'monthly')),
  CONSTRAINT standing_orders_status_chk CHECK (status IN ('active', 'paused', 'suspended', 'completed', 'cancelled')),
  CONSTRAINT standing_orders_distinct_accounts_chk CHECK (source_account_id <> destination_account_id),
  CONSTRAINT standing_orders_retry_chk CHECK (retry_after_days > 0 AND max_consecutive_failures > 0)
);

CREATE INDEX ON standing_orders (next_run_date) WHERE status = 'active';
CREATE INDEX ON standing_orders (source_account_id);

CREATE TABLE standing_order_runs (
  id BIGSERIAL PRIMARY KEY,
  standing_order_id BIGINT NOT NULL REFERENCES standing_orders(id),
  run_date DATE NOT NULL,
  status VARCHAR(20) NOT NULL,
  failure_reason TEXT,
  -- The debit leg on the source account; the matching credit on the
  -- destination is found via the same journal entry.
  transaction_id BIGINT REFERENCES savings_transactions(id),
  -- Set true once the customer has actually been told about a failure.
  -- Nothing sets it yet — there is no notification service (see
  -- Decisions_Log.md Open Questions) — so an unnotified failure is
  -- queryable rather than silently lost.
  customer_notified BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT standing_order_runs_status_chk CHECK (status IN ('success', 'failed'))
);

CREATE INDEX ON standing_order_runs (standing_order_id);
CREATE INDEX ON standing_order_runs (status) WHERE status = 'failed';
