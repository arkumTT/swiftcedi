-- Module 1: branch-to-branch cash-in-transit transfers. Customer-account
-- transfers between branches (the other half of the Module 1 prompt's
-- "branch-to-branch transfers" requirement) are NOT built here — there is
-- no `customers` table yet (Module 2). See Decisions_Log.md Open Questions.

CREATE TABLE branch_transfers (
  id BIGSERIAL PRIMARY KEY,
  source_branch_id BIGINT NOT NULL REFERENCES branches(id),
  destination_branch_id BIGINT NOT NULL REFERENCES branches(id),
  amount_pesewas BIGINT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  reason TEXT,
  initiated_by BIGINT NOT NULL REFERENCES users(id),
  confirmed_by BIGINT REFERENCES users(id),
  cancelled_by BIGINT REFERENCES users(id),
  out_journal_entry_id BIGINT REFERENCES gl_journal_entries(id),
  in_journal_entry_id BIGINT REFERENCES gl_journal_entries(id),
  reversal_journal_entry_id BIGINT REFERENCES gl_journal_entries(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT branch_transfers_amount_chk CHECK (amount_pesewas > 0),
  CONSTRAINT branch_transfers_distinct_branches_chk CHECK (source_branch_id <> destination_branch_id),
  CONSTRAINT branch_transfers_status_chk CHECK (status IN ('pending', 'in_transit', 'completed', 'cancelled'))
);

CREATE INDEX ON branch_transfers (source_branch_id);
CREATE INDEX ON branch_transfers (destination_branch_id);
CREATE INDEX ON branch_transfers (status);
