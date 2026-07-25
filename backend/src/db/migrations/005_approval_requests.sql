-- Module 11: shared maker-checker approval workflow. Every module that
-- needs dual-control approval creates a row here via
-- backend/src/shared/approvalWorkflow.js — no module reimplements this.

CREATE TABLE approval_requests (
  id BIGSERIAL PRIMARY KEY,
  action_type VARCHAR(80) NOT NULL, -- e.g. 'loan.disburse', 'branch.close'
  entity_type VARCHAR(80) NOT NULL,
  entity_id VARCHAR(80),
  branch_id BIGINT NOT NULL REFERENCES branches(id),
  amount_pesewas BIGINT,
  payload JSONB,
  requested_by BIGINT NOT NULL REFERENCES users(id),
  required_approver_role_id BIGINT REFERENCES roles(id),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  decided_by BIGINT REFERENCES users(id),
  decided_at TIMESTAMPTZ,
  decision_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT approval_requests_status_chk
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  -- Maker-checker, enforced at the database layer: the approver can never
  -- be the requester.
  CONSTRAINT approval_requests_maker_checker_chk
    CHECK (decided_by IS NULL OR decided_by <> requested_by)
);

CREATE INDEX ON approval_requests (status);
CREATE INDEX ON approval_requests (branch_id);
CREATE INDEX ON approval_requests (entity_type, entity_id);
CREATE INDEX ON approval_requests (requested_by);
