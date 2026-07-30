-- Loan module amendment (payments): a real lookup table, not a CHECK-
-- constraint enum, specifically so a bank transfer or cheque mode can be
-- added later with a plain INSERT rather than a schema migration — same
-- reasoning as roles/permissions/branches being real tables instead of
-- enums. See Decisions_Log.md "Repayment payment mode & receiver".

CREATE TABLE payment_modes (
  id BIGSERIAL PRIMARY KEY,
  code VARCHAR(30) NOT NULL UNIQUE,
  name VARCHAR(60) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payment_modes_status_chk CHECK (status IN ('active', 'inactive'))
);

INSERT INTO payment_modes (code, name) VALUES
  ('cash', 'Cash'),
  ('mobile_money', 'Mobile Money (Digital)');
