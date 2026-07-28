-- Officer-negotiated concessions against a loan's standard product terms.
-- Every field a loan officer could negotiate keeps its STANDARD (the
-- product's current terms, at the moment of the request) value alongside
-- the NEGOTIATED value — "visible on the loan detail view with a clear
-- standard vs negotiated comparison, not silently blended in" is
-- satisfied structurally by keeping both, not by only storing the delta.
--
-- standard/negotiated_spread_bps are only populated when the loan's
-- product is FLOATING (an officer only ever negotiates the bank's own
-- margin, never the reference rate) — NULL for a fixed-product
-- concession, where the rate columns alone are the whole story.
--
-- applied_floor_bps snapshots the exact bound
-- (loan_products.min_rate_floor_bps or min_spread_floor_bps, whichever
-- applied) that was checked at request time, so a later edit to the
-- product's floor can never retroactively make a past decision look
-- wrong — same "snapshot what was actually enforced" discipline as
-- everything else in this module.
--
-- Deliberately has NO status/decided_by/decided_at columns of its own —
-- same convention loan_restructures (migration 024) already established:
-- the decision lives on approval_requests (joined via approval_request_id)
-- and is never duplicated here, so there is nothing that can go stale.
-- approvalWorkflow.decide()'s registered execution handler only ever
-- fires on APPROVAL, never rejection (see backend/src/shared/
-- approvalWorkflow.js), so a column here that tried to mirror
-- approval_requests.status would be left wrong forever on a rejected
-- concession — reading it live via the join avoids that entirely. The
-- one case with no approval_requests row to join to is a concession
-- that fell within the product's concession_approval_threshold_bps
-- grace window and applied immediately (approval_request_id stays NULL)
-- — loanService's getters treat NULL approval_request_id as "approved,
-- applied immediately at created_at" rather than needing their own
-- status column for it.

CREATE TABLE loan_concessions (
  id BIGSERIAL PRIMARY KEY,
  loan_id BIGINT NOT NULL REFERENCES loans(id),
  requested_by BIGINT NOT NULL REFERENCES users(id),
  reason_code VARCHAR(40) NOT NULL,
  reason_notes TEXT,
  standard_annual_interest_rate_bps INT NOT NULL,
  negotiated_annual_interest_rate_bps INT NOT NULL,
  standard_spread_bps INT,
  negotiated_spread_bps INT,
  applied_floor_bps INT,
  standard_term_months INT NOT NULL,
  negotiated_term_months INT NOT NULL,
  standard_fee_schedule JSONB NOT NULL,
  negotiated_fee_schedule JSONB NOT NULL,
  approval_request_id BIGINT REFERENCES approval_requests(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT loan_concessions_reason_chk
    CHECK (reason_code IN ('loyal_customer', 'competitive_match', 'hardship', 'other'))
);

CREATE INDEX ON loan_concessions (loan_id);
CREATE INDEX ON loan_concessions (approval_request_id);
