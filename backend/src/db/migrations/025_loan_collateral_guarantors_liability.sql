-- Module 3: collateral/guarantor tracking, and the joint-liability
-- snapshot for group loans.

CREATE TABLE loan_collateral (
  id BIGSERIAL PRIMARY KEY,
  loan_id BIGINT NOT NULL REFERENCES loans(id),
  description TEXT NOT NULL,
  estimated_value_pesewas BIGINT,
  verification_status VARCHAR(20) NOT NULL DEFAULT 'pending',
  verified_by BIGINT REFERENCES users(id),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT loan_collateral_status_chk CHECK (verification_status IN ('pending', 'verified', 'rejected'))
);

CREATE INDEX ON loan_collateral (loan_id);

CREATE TABLE loan_guarantors (
  id BIGSERIAL PRIMARY KEY,
  loan_id BIGINT NOT NULL REFERENCES loans(id),
  customer_id BIGINT REFERENCES customers(id),
  guarantor_name VARCHAR(150),
  guarantor_phone VARCHAR(20),
  guaranteed_amount_pesewas BIGINT,
  verification_status VARCHAR(20) NOT NULL DEFAULT 'pending',
  verified_by BIGINT REFERENCES users(id),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT loan_guarantors_status_chk CHECK (verification_status IN ('pending', 'verified', 'rejected')),
  CONSTRAINT loan_guarantors_identity_chk CHECK (customer_id IS NOT NULL OR guarantor_name IS NOT NULL)
);

CREATE INDEX ON loan_guarantors (loan_id);

-- Snapshot of which individual group members were jointly liable at the
-- time a group loan was disbursed — group membership (Module 2) can
-- change afterward, but liability for an existing loan shouldn't silently
-- shift with it.
CREATE TABLE loan_group_liabilities (
  id BIGSERIAL PRIMARY KEY,
  loan_id BIGINT NOT NULL REFERENCES loans(id),
  customer_id BIGINT NOT NULL REFERENCES customers(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (loan_id, customer_id)
);

CREATE INDEX ON loan_group_liabilities (loan_id);
