-- Module 2: moving a customer's home branch, with full history preserved.
-- This resolves Module 1's Open Question on how "home branch" interacts
-- with branch-to-branch transfers: this table is customer-specific and
-- independent of Module 1's `branch_transfers` (which is cash-in-transit
-- only) — the two never overlap. Not maker-checker gated (unlike account
-- closure): moving a customer's branch has no direct financial impact by
-- itself, so it's a direct, audited, permission-gated action.

CREATE TABLE customer_branch_transfers (
  id BIGSERIAL PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers(id),
  from_branch_id BIGINT NOT NULL REFERENCES branches(id),
  to_branch_id BIGINT NOT NULL REFERENCES branches(id),
  transferred_by BIGINT NOT NULL REFERENCES users(id),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT customer_branch_transfers_distinct_chk CHECK (from_branch_id <> to_branch_id)
);

CREATE INDEX ON customer_branch_transfers (customer_id);
