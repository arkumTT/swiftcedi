-- Module 1: links each branch to its auto-generated GL sub-accounts, and
-- captures branch-level vault/till configuration (opening float, daily
-- limits). Actual day-to-day till open/close operations belong to Module 6
-- (Cashier/Till/Vault) — this table is just the branch's static config.

CREATE TABLE branch_gl_accounts (
  branch_id BIGINT PRIMARY KEY REFERENCES branches(id),
  cash_in_hand_account_id BIGINT NOT NULL REFERENCES gl_accounts(id),
  vault_account_id BIGINT NOT NULL REFERENCES gl_accounts(id),
  income_account_id BIGINT NOT NULL REFERENCES gl_accounts(id),
  expense_account_id BIGINT NOT NULL REFERENCES gl_accounts(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE branch_vault_configs (
  branch_id BIGINT PRIMARY KEY REFERENCES branches(id),
  opening_float_pesewas BIGINT NOT NULL DEFAULT 0,
  daily_cash_limit_pesewas BIGINT NOT NULL DEFAULT 0,
  denomination_breakdown JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT branch_vault_configs_nonneg_chk CHECK (
    opening_float_pesewas >= 0 AND daily_cash_limit_pesewas >= 0
  )
);
