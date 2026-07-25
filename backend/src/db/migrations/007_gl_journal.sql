-- Module 7: the double-entry journal. This is the only ledger surface —
-- every other module posts through backend/src/shared/glPosting.js, which
-- is the only code path allowed to INSERT here.

CREATE TABLE gl_journal_entries (
  id BIGSERIAL PRIMARY KEY,
  branch_id BIGINT NOT NULL REFERENCES branches(id),
  reference VARCHAR(80) NOT NULL,
  entry_type VARCHAR(30) NOT NULL DEFAULT 'standard',
  description TEXT,
  entry_date DATE NOT NULL,
  source_module VARCHAR(40) NOT NULL, -- e.g. 'loan', 'savings', 'cashier', 'manual_jv'
  created_by BIGINT NOT NULL REFERENCES users(id),
  approved_by BIGINT REFERENCES users(id),
  status VARCHAR(20) NOT NULL DEFAULT 'posted',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT gl_journal_entries_type_chk CHECK (entry_type IN ('standard', 'prior_period_adjustment')),
  CONSTRAINT gl_journal_entries_status_chk CHECK (status IN ('posted', 'reversed')),
  -- Maker-checker: when an entry does carry an approver, it must differ
  -- from whoever created it.
  CONSTRAINT gl_journal_entries_maker_checker_chk CHECK (approved_by IS NULL OR approved_by <> created_by)
);

CREATE INDEX ON gl_journal_entries (branch_id);
CREATE INDEX ON gl_journal_entries (entry_date);
CREATE INDEX ON gl_journal_entries (source_module);

CREATE TABLE gl_journal_lines (
  id BIGSERIAL PRIMARY KEY,
  journal_entry_id BIGINT NOT NULL REFERENCES gl_journal_entries(id),
  account_id BIGINT NOT NULL REFERENCES gl_accounts(id),
  debit_pesewas BIGINT NOT NULL DEFAULT 0,
  credit_pesewas BIGINT NOT NULL DEFAULT 0,
  branch_id BIGINT NOT NULL REFERENCES branches(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT gl_journal_lines_dr_xor_cr_chk CHECK (
    (debit_pesewas > 0 AND credit_pesewas = 0) OR
    (credit_pesewas > 0 AND debit_pesewas = 0)
  )
);

CREATE INDEX ON gl_journal_lines (account_id);
CREATE INDEX ON gl_journal_lines (journal_entry_id);

-- Balanced-entry guarantee, enforced at the database layer as a second
-- line of defense behind the application-layer check in glPosting.js.
-- Deferred to end-of-transaction so a multi-line INSERT can build up an
-- entry line by line and only has to balance by COMMIT.
CREATE OR REPLACE FUNCTION check_gl_journal_balanced() RETURNS TRIGGER AS $$
DECLARE
  v_journal_entry_id BIGINT;
  v_diff BIGINT;
BEGIN
  v_journal_entry_id := COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);

  SELECT COALESCE(SUM(debit_pesewas), 0) - COALESCE(SUM(credit_pesewas), 0)
    INTO v_diff
    FROM gl_journal_lines
    WHERE journal_entry_id = v_journal_entry_id;

  IF v_diff <> 0 THEN
    RAISE EXCEPTION 'gl_journal_entries % is unbalanced: debit/credit difference = % pesewas',
      v_journal_entry_id, v_diff;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_gl_journal_lines_balanced
  AFTER INSERT ON gl_journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_gl_journal_balanced();

-- Immutability: journal lines are never edited or deleted once posted.
-- Corrections are a new reversing entry (rule 5 / Module 7 business rules).
CREATE OR REPLACE FUNCTION prevent_gl_journal_lines_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'gl_journal_lines rows are immutable (%); post a reversing entry instead', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_gl_journal_lines_immutable
  BEFORE UPDATE OR DELETE ON gl_journal_lines
  FOR EACH ROW EXECUTE FUNCTION prevent_gl_journal_lines_mutation();
