-- Module 4: susu (periodic informal collection) accounts, field
-- collections, and agent commissions.
--
-- ANSWERS Module 4's "BEFORE YOU WRITE CODE" question about the join key
-- into Module 10 (Agent & Field Operations): `susu_collections.agent_id`
-- references **users(id)** — the agent's staff/user record — NOT a
-- Module-10 `field_agents` row (which doesn't exist yet). Module 10's
-- `field_agents` table is specced as "linked to a staff/user record", so
-- it will hang off the same users(id); joining
-- susu_collections -> users <- field_agents gives Module 10 its
-- reconciliation input without this module depending on a table that
-- isn't built. See Decisions_Log.md for the double-counting guarantee.

CREATE TABLE susu_accounts (
  id BIGSERIAL PRIMARY KEY,
  account_no VARCHAR(30) UNIQUE NOT NULL,
  customer_id BIGINT NOT NULL REFERENCES customers(id),
  branch_id BIGINT NOT NULL REFERENCES branches(id),
  -- Where the cycle proceeds are paid out on completion.
  payout_savings_account_id BIGINT REFERENCES savings_accounts(id),
  cycle_length_days INT NOT NULL,
  expected_collection_pesewas BIGINT NOT NULL,
  target_amount_pesewas BIGINT NOT NULL,
  collected_pesewas BIGINT NOT NULL DEFAULT 0,
  -- Commission rate in basis points of each collection, integer (never a
  -- float), same convention as loan interest rates in Module 3.
  commission_rate_bps INT NOT NULL DEFAULT 0,
  assigned_agent_id BIGINT REFERENCES users(id),
  cycle_start_date DATE NOT NULL,
  cycle_end_date DATE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  closed_at TIMESTAMPTZ,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 'completed'   = cycle finished having reached target, payout due
  -- 'uncompleted' = cycle finished short of target
  -- 'paid_out'    = proceeds transferred out, account settled
  CONSTRAINT susu_accounts_status_chk CHECK (status IN ('active', 'completed', 'uncompleted', 'paid_out')),
  CONSTRAINT susu_accounts_amounts_chk CHECK (
    cycle_length_days > 0 AND expected_collection_pesewas > 0 AND target_amount_pesewas > 0
    AND collected_pesewas >= 0 AND commission_rate_bps >= 0
  ),
  CONSTRAINT susu_accounts_dates_chk CHECK (cycle_end_date >= cycle_start_date)
);

CREATE INDEX ON susu_accounts (customer_id);
CREATE INDEX ON susu_accounts (branch_id);
CREATE INDEX ON susu_accounts (assigned_agent_id);
CREATE INDEX ON susu_accounts (status);

CREATE TABLE susu_collections (
  id BIGSERIAL PRIMARY KEY,
  susu_account_id BIGINT NOT NULL REFERENCES susu_accounts(id),
  agent_id BIGINT NOT NULL REFERENCES users(id),
  amount_pesewas BIGINT NOT NULL,
  collection_date DATE NOT NULL,
  gps_lat NUMERIC(9, 6),
  gps_lng NUMERIC(9, 6),
  -- Client-generated, so an agent retrying a submission over a flaky
  -- connection cannot double-post. UNIQUE is the actual guarantee; the
  -- service returns the existing row on a repeat rather than erroring.
  idempotency_key VARCHAR(80) NOT NULL UNIQUE,
  journal_entry_id BIGINT REFERENCES gl_journal_entries(id),
  -- Set once the agent banks this cash at the branch; NULL means the
  -- agent is still holding it (mirrors the 1030 Cash with Agents balance).
  remittance_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT susu_collections_amount_chk CHECK (amount_pesewas > 0)
);

CREATE INDEX ON susu_collections (susu_account_id);
CREATE INDEX ON susu_collections (agent_id);
CREATE INDEX ON susu_collections (collection_date);
CREATE INDEX ON susu_collections (remittance_id);

CREATE OR REPLACE FUNCTION prevent_susu_collections_mutation() RETURNS TRIGGER AS $$
BEGIN
  -- Immutable apart from the one-time journal_entry_id stamp and the
  -- one-time remittance_id stamp (set when the agent banks the cash).
  IF TG_OP = 'UPDATE'
     AND ROW(NEW.id, NEW.susu_account_id, NEW.agent_id, NEW.amount_pesewas, NEW.collection_date,
             NEW.idempotency_key, NEW.created_at)
       IS NOT DISTINCT FROM
         ROW(OLD.id, OLD.susu_account_id, OLD.agent_id, OLD.amount_pesewas, OLD.collection_date,
             OLD.idempotency_key, OLD.created_at)
     AND (OLD.journal_entry_id IS NULL OR NEW.journal_entry_id IS NOT DISTINCT FROM OLD.journal_entry_id)
     AND (OLD.remittance_id IS NULL OR NEW.remittance_id IS NOT DISTINCT FROM OLD.remittance_id)
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'susu_collections rows are immutable (%)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_susu_collections_immutable
  BEFORE UPDATE OR DELETE ON susu_collections
  FOR EACH ROW EXECUTE FUNCTION prevent_susu_collections_mutation();

CREATE TABLE susu_commissions (
  id BIGSERIAL PRIMARY KEY,
  susu_account_id BIGINT NOT NULL REFERENCES susu_accounts(id),
  collection_id BIGINT UNIQUE REFERENCES susu_collections(id),
  agent_id BIGINT NOT NULL REFERENCES users(id),
  amount_pesewas BIGINT NOT NULL,
  basis VARCHAR(20) NOT NULL,
  journal_entry_id BIGINT REFERENCES gl_journal_entries(id),
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT susu_commissions_basis_chk CHECK (basis IN ('per_collection', 'per_cycle')),
  CONSTRAINT susu_commissions_amount_chk CHECK (amount_pesewas >= 0)
);

CREATE INDEX ON susu_commissions (agent_id);
CREATE INDEX ON susu_commissions (susu_account_id);

-- An agent banking their field cash at the branch. Module 10's end-of-day
-- reconciliation compares the collections attached to a remittance against
-- what the cashier actually received.
CREATE TABLE agent_remittances (
  id BIGSERIAL PRIMARY KEY,
  agent_id BIGINT NOT NULL REFERENCES users(id),
  branch_id BIGINT NOT NULL REFERENCES branches(id),
  amount_pesewas BIGINT NOT NULL,
  collection_count INT NOT NULL,
  remitted_on DATE NOT NULL,
  journal_entry_id BIGINT REFERENCES gl_journal_entries(id),
  received_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_remittances_amount_chk CHECK (amount_pesewas > 0)
);

CREATE INDEX ON agent_remittances (agent_id);
CREATE INDEX ON agent_remittances (remitted_on);

ALTER TABLE susu_collections
  ADD CONSTRAINT susu_collections_remittance_fkey FOREIGN KEY (remittance_id) REFERENCES agent_remittances(id);
