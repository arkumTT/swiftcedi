-- Module 11: RBAC core — roles, permissions, users.

CREATE TABLE roles (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(60) UNIQUE NOT NULL,
  description TEXT,
  is_system_role BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE permissions (
  id BIGSERIAL PRIMARY KEY,
  code VARCHAR(80) UNIQUE NOT NULL, -- e.g. 'loan.disburse', 'gl.post_journal'
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE role_permissions (
  role_id BIGINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id BIGINT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  full_name VARCHAR(150) NOT NULL,
  email VARCHAR(150) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role_id BIGINT NOT NULL REFERENCES roles(id),
  home_branch_id BIGINT NOT NULL REFERENCES branches(id),
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_status_chk CHECK (status IN ('active', 'suspended', 'disabled'))
);

CREATE INDEX ON users (role_id);
CREATE INDEX ON users (home_branch_id);

-- Seed a minimal system-role set so approval_thresholds / seed users have
-- something to reference. Full role/permission catalogue is admin-managed
-- via the CRUD endpoints, not hardcoded beyond this baseline.
INSERT INTO roles (name, description, is_system_role) VALUES
  ('owner', 'Owner / Executive — full cross-branch access', true),
  ('branch_manager', 'Branch Manager — full access scoped to home branch', true),
  ('loan_officer', 'Loan Officer', true),
  ('cashier', 'Cashier / Teller', true),
  ('field_agent', 'Field Agent', true),
  ('system_admin', 'System Administrator', true);
