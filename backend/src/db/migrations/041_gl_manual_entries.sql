-- Module 7: maker-checker for manual journal-voucher (JV) entries. The
-- spec's API list names "JV entry creation (validated balanced) and
-- approval" as two distinct steps — until now, POST /gl/journal-entries
-- posted immediately with only a permission check, no approval, despite
-- a hand-entered manual JV being arguably the single most arbitrary,
-- error-prone entry point in the whole system (no business-rule
-- validation beyond "it balances," unlike every module's own postings
-- which are already gated by that module's own upstream approval step —
-- e.g. a loan disbursement requires loan.approve first).
--
-- Deliberately a SEPARATE table from gl_prior_period_adjustments
-- (migration 038) even though the shape is nearly identical: that table
-- is specifically for corrections into a LOCKED period (posted with
-- entryType = 'prior_period_adjustment'); this one is for ordinary,
-- open-period manual entries. Keeping them distinct keeps each table's
-- name meaningful — gl_prior_period_adjustments could not be reused here
-- without becoming misleading for an everyday in-period JV.
--
-- ALWAYS maker-checker, no threshold — a manual JV has no natural
-- "product" to hang a configurable default threshold off (unlike
-- savings/investment/cashier actions), so defaulting to "safe" here
-- means always-approval, the same treatment as loan.approve,
-- investment.book/redeem, and gl.reversal.

CREATE TABLE gl_manual_entries (
  id BIGSERIAL PRIMARY KEY,
  branch_id BIGINT NOT NULL REFERENCES branches(id),
  entry_date DATE NOT NULL,
  description TEXT NOT NULL,
  lines JSONB NOT NULL,
  approval_request_id BIGINT UNIQUE REFERENCES approval_requests(id),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  journal_entry_id BIGINT REFERENCES gl_journal_entries(id),
  requested_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT gl_manual_entries_status_chk CHECK (status IN ('pending', 'approved', 'posted', 'rejected'))
);

CREATE INDEX ON gl_manual_entries (branch_id);
CREATE INDEX ON gl_manual_entries (status);
