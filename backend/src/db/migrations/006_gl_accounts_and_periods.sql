-- Module 7: chart of accounts and period locking.

CREATE TABLE gl_accounts (
  id BIGSERIAL PRIMARY KEY,
  code VARCHAR(20) UNIQUE NOT NULL,
  name VARCHAR(150) NOT NULL,
  account_type VARCHAR(20) NOT NULL,
  branch_id BIGINT REFERENCES branches(id), -- NULL = head-office / consolidated-level account
  parent_account_id BIGINT REFERENCES gl_accounts(id),
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT gl_accounts_type_chk CHECK (account_type IN ('asset', 'liability', 'equity', 'income', 'expense')),
  CONSTRAINT gl_accounts_status_chk CHECK (status IN ('active', 'inactive'))
);

CREATE INDEX ON gl_accounts (branch_id);
CREATE INDEX ON gl_accounts (account_type);

CREATE TABLE gl_periods (
  id BIGSERIAL PRIMARY KEY,
  branch_id BIGINT REFERENCES branches(id), -- NULL = org-wide period lock
  period_type VARCHAR(10) NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  locked BOOLEAN NOT NULL DEFAULT false,
  locked_by BIGINT REFERENCES users(id),
  locked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT gl_periods_type_chk CHECK (period_type IN ('month', 'year')),
  UNIQUE (branch_id, period_type, period_start)
);
