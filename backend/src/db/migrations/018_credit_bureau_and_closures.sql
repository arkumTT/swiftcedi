-- Module 2: credit bureau lookup history, and account closures.
--
-- account_closures deliberately does NOT duplicate requested_by/approved_by/
-- status columns — it references the approval_requests row that IS the
-- maker-checker record for the closure (via the shared approvalWorkflow
-- service, exactly as Module 1 did for branch closure), and derives those
-- fields by joining. This avoids two copies of "is this closure pending or
-- approved" ever disagreeing. See Decisions_Log.md.

CREATE TABLE credit_bureau_lookups (
  id BIGSERIAL PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers(id),
  requested_by BIGINT NOT NULL REFERENCES users(id),
  request_payload JSONB,
  response_payload JSONB,
  status VARCHAR(20) NOT NULL DEFAULT 'completed',
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT credit_bureau_lookups_status_chk CHECK (status IN ('completed', 'failed'))
);

CREATE INDEX ON credit_bureau_lookups (customer_id);

CREATE TABLE account_closures (
  id BIGSERIAL PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers(id),
  approval_request_id BIGINT NOT NULL UNIQUE REFERENCES approval_requests(id),
  reason_code VARCHAR(60) NOT NULL,
  reason_notes TEXT,
  closure_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON account_closures (customer_id);
