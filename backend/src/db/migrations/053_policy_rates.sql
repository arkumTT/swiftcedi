-- Loan Products extension: admin-configurable reference/base rates that
-- FLOATING loan products link to (e.g. a bank's own prime/base rate),
-- rather than hardcoding a rate inside a product row. Every change goes
-- through the shared audit-log service (backend/src/shared/auditLog.js),
-- same as every other mutation in this codebase — no bespoke audit table
-- of its own — but a rate's effective-dated history is genuinely
-- different data (what WAS the rate on a given past date, for
-- reconstructing a historical reset), not just a before/after audit
-- entry, so policy_rate_changes exists alongside the audit log rather
-- than instead of it.

CREATE TABLE policy_rates (
  id BIGSERIAL PRIMARY KEY,
  code VARCHAR(30) UNIQUE NOT NULL,
  name VARCHAR(100) NOT NULL,
  rate_bps INT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT policy_rates_rate_chk CHECK (rate_bps >= 0),
  CONSTRAINT policy_rates_status_chk CHECK (status IN ('active', 'inactive'))
);

CREATE TABLE policy_rate_changes (
  id BIGSERIAL PRIMARY KEY,
  policy_rate_id BIGINT NOT NULL REFERENCES policy_rates(id),
  old_rate_bps INT NOT NULL,
  new_rate_bps INT NOT NULL,
  effective_date DATE NOT NULL,
  changed_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON policy_rate_changes (policy_rate_id, effective_date);
