-- Module 11: maker-checker thresholds, restricted-account access, time windows.

CREATE TABLE approval_thresholds (
  id BIGSERIAL PRIMARY KEY,
  action_type VARCHAR(80) NOT NULL,
  branch_id BIGINT REFERENCES branches(id), -- NULL = applies to all branches
  amount_threshold_pesewas BIGINT NOT NULL DEFAULT 0,
  required_approver_role_id BIGINT NOT NULL REFERENCES roles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT approval_thresholds_amount_chk CHECK (amount_threshold_pesewas >= 0)
);

-- One threshold row per (action_type, branch_id): a branch-specific row
-- overrides the org-wide (branch_id IS NULL) row for that action_type.
CREATE UNIQUE INDEX approval_thresholds_branch_action_uq
  ON approval_thresholds (action_type, COALESCE(branch_id, 0));

CREATE TABLE restricted_account_access (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL,
  account_type VARCHAR(40) NOT NULL, -- e.g. 'savings_account', 'loan' — real FK added once those tables exist
  user_id BIGINT NOT NULL REFERENCES users(id),
  granted_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, account_type, user_id)
);

CREATE TABLE access_time_windows (
  id BIGSERIAL PRIMARY KEY,
  role_id BIGINT NOT NULL REFERENCES roles(id),
  allowed_days SMALLINT[] NOT NULL, -- 0=Sunday .. 6=Saturday
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON access_time_windows (role_id);
