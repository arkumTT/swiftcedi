-- Module 3: repayment schedule and the append-only repayment ledger.
-- `schedule_version` is how restructuring "preserves the original
-- schedule and all prior repayment history for audit" (business rule) —
-- restructuring bumps loans.current_schedule_version and inserts a NEW
-- set of rows at the new version; old-version rows and the repayments
-- posted against them are never touched. Repayments "post against"
-- schedule rows by incrementing the *_paid_pesewas columns — schedule
-- rows are never overwritten, only accumulated onto.

CREATE TABLE loan_schedules (
  id BIGSERIAL PRIMARY KEY,
  loan_id BIGINT NOT NULL REFERENCES loans(id),
  schedule_version INT NOT NULL DEFAULT 1,
  installment_number INT NOT NULL,
  due_date DATE NOT NULL,
  principal_due_pesewas BIGINT NOT NULL,
  interest_due_pesewas BIGINT NOT NULL,
  fees_due_pesewas BIGINT NOT NULL DEFAULT 0,
  principal_paid_pesewas BIGINT NOT NULL DEFAULT 0,
  interest_paid_pesewas BIGINT NOT NULL DEFAULT 0,
  fees_paid_pesewas BIGINT NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT loan_schedules_status_chk CHECK (status IN ('pending', 'partially_paid', 'paid')),
  CONSTRAINT loan_schedules_due_nonneg_chk CHECK (
    principal_due_pesewas >= 0 AND interest_due_pesewas >= 0 AND fees_due_pesewas >= 0
  ),
  CONSTRAINT loan_schedules_paid_nonneg_chk CHECK (
    principal_paid_pesewas >= 0 AND interest_paid_pesewas >= 0 AND fees_paid_pesewas >= 0
  ),
  UNIQUE (loan_id, schedule_version, installment_number)
);

CREATE INDEX ON loan_schedules (loan_id, schedule_version);
CREATE INDEX ON loan_schedules (due_date);

CREATE TABLE loan_repayments (
  id BIGSERIAL PRIMARY KEY,
  loan_id BIGINT NOT NULL REFERENCES loans(id),
  schedule_id BIGINT NOT NULL REFERENCES loan_schedules(id),
  amount_pesewas BIGINT NOT NULL,
  principal_component_pesewas BIGINT NOT NULL DEFAULT 0,
  interest_component_pesewas BIGINT NOT NULL DEFAULT 0,
  fees_component_pesewas BIGINT NOT NULL DEFAULT 0,
  payment_date DATE NOT NULL,
  received_by BIGINT NOT NULL REFERENCES users(id),
  journal_entry_id BIGINT REFERENCES gl_journal_entries(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT loan_repayments_amount_chk CHECK (amount_pesewas > 0),
  CONSTRAINT loan_repayments_components_sum_chk CHECK (
    amount_pesewas = principal_component_pesewas + interest_component_pesewas + fees_component_pesewas
  )
);

CREATE INDEX ON loan_repayments (loan_id);
CREATE INDEX ON loan_repayments (schedule_id);

-- Append-only, same reasoning as gl_journal_lines/audit_log: a correction
-- is a new posting, never an edit to a past payment record.
--
-- ONE narrow exception: stamping journal_entry_id once, NULL -> value.
-- glPosting.postJournalEntry() owns its own transaction (it is the single
-- funnel every module posts through — see Decisions_Log.md), so the
-- journal entry id does not exist yet at the moment the repayment row is
-- inserted. Every financial field (amounts, components, dates, the
-- schedule row it posts against) stays immutable; only this one-time FK
-- linkage may be filled in, and only while it is still NULL.
CREATE OR REPLACE FUNCTION prevent_loan_repayments_mutation() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.journal_entry_id IS NULL
     AND NEW.journal_entry_id IS NOT NULL
     AND ROW(NEW.id, NEW.loan_id, NEW.schedule_id, NEW.amount_pesewas, NEW.principal_component_pesewas,
             NEW.interest_component_pesewas, NEW.fees_component_pesewas, NEW.payment_date, NEW.received_by, NEW.created_at)
       IS NOT DISTINCT FROM
         ROW(OLD.id, OLD.loan_id, OLD.schedule_id, OLD.amount_pesewas, OLD.principal_component_pesewas,
             OLD.interest_component_pesewas, OLD.fees_component_pesewas, OLD.payment_date, OLD.received_by, OLD.created_at)
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'loan_repayments rows are immutable (%)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_loan_repayments_immutable
  BEFORE UPDATE OR DELETE ON loan_repayments
  FOR EACH ROW EXECUTE FUNCTION prevent_loan_repayments_mutation();

CREATE TABLE loan_restructures (
  id BIGSERIAL PRIMARY KEY,
  loan_id BIGINT NOT NULL REFERENCES loans(id),
  approval_request_id BIGINT NOT NULL UNIQUE REFERENCES approval_requests(id),
  old_schedule_version INT NOT NULL,
  new_schedule_version INT NOT NULL,
  new_term_months INT NOT NULL,
  new_annual_interest_rate_bps INT NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON loan_restructures (loan_id);
