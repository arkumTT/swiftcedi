-- Shared GL infra (Module 7's domain, extended here because Module 6 is
-- the first module that actually needs it): back-dated corrections into a
-- LOCKED gl_periods row require their own maker-checker workflow with
-- "extra approval" per Module 6's business rules ("late corrections go
-- through a distinct back-dated adjustment workflow with extra
-- approval"). This is deliberately NOT limited to Module 6 — any module
-- could discover a correction is needed after period-close, so this table
-- and its two glPosting.js functions (requestPriorPeriodAdjustment /
-- applyPriorPeriodAdjustment) live at the shared-services layer, same
-- reasoning as reverseJournalEntry (migration 037).
--
-- `lines` snapshots the PROPOSED journal lines at request time (same
-- reasoning as loan_restructures snapshotting proposed new terms) so what
-- gets posted on approval can never silently drift from what was
-- reviewed. Posting itself always uses entryType = 'prior_period_adjustment'
-- (the only value assertPeriodOpen() lets through a locked period).

CREATE TABLE gl_prior_period_adjustments (
  id BIGSERIAL PRIMARY KEY,
  branch_id BIGINT NOT NULL REFERENCES branches(id),
  entry_date DATE NOT NULL,
  description TEXT NOT NULL,
  lines JSONB NOT NULL,
  -- Nullable at insert: the adjustment row is created FIRST so it has an
  -- id to hand to approvalWorkflow.requestApproval() as entityId, then
  -- stamped once the approval request exists (same "create the row,
  -- reference it in the approval, then stamp back" order Module 3's loan
  -- restructure and Module 6's own cash_back_requests use).
  approval_request_id BIGINT UNIQUE REFERENCES approval_requests(id),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  journal_entry_id BIGINT REFERENCES gl_journal_entries(id),
  requested_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT gl_prior_period_adjustments_status_chk CHECK (status IN ('pending', 'approved', 'posted', 'rejected'))
);

CREATE INDEX ON gl_prior_period_adjustments (branch_id);
CREATE INDEX ON gl_prior_period_adjustments (status);
