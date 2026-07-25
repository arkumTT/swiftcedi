-- Module 11: shared, append-only audit log. Every write to a financial
-- table across every module routes through the audit-log service
-- (backend/src/shared/auditLog.js), which is the only writer to this table.

CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id), -- NULL only for genuinely system-initiated actions (e.g. scheduled jobs)
  branch_id BIGINT NOT NULL REFERENCES branches(id),
  action VARCHAR(120) NOT NULL, -- e.g. 'loan.disburse', 'gl.post_journal'
  entity_type VARCHAR(80) NOT NULL,
  entity_id VARCHAR(80) NOT NULL, -- text to accommodate composite/non-numeric ids
  before_state JSONB,
  after_state JSONB,
  ip_address VARCHAR(45),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON audit_log (entity_type, entity_id);
CREATE INDEX ON audit_log (user_id);
CREATE INDEX ON audit_log (branch_id);
CREATE INDEX ON audit_log (created_at);

-- Immutability: audit_log rows are append-only. Enforce it in the database,
-- not just by convention, since every module writes here.
CREATE OR REPLACE FUNCTION prevent_audit_log_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is immutable: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_log_immutable
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();
