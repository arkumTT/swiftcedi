-- Module 2: customer identity core. One polymorphic table for all three
-- customer types (individual/group/sme) rather than per-type tables — the
-- type-specific fields are simply nullable and validated per-type in
-- customerService.js (see Decisions_Log.md). A 'group' row here is the
-- group's own borrowing/account-holding identity; group structure itself
-- (leader, members) lives in groups/group_members (migration 017).

CREATE TABLE customers (
  id BIGSERIAL PRIMARY KEY,
  customer_type VARCHAR(20) NOT NULL,
  branch_id BIGINT NOT NULL REFERENCES branches(id),
  full_name VARCHAR(150) NOT NULL, -- individual's name / group's display name / SME's business name
  ghana_card_no VARCHAR(20), -- individual only
  date_of_birth DATE, -- individual only
  gender VARCHAR(10), -- individual only
  business_registration_no VARCHAR(60), -- sme only
  contact_person_name VARCHAR(150), -- sme only
  phone VARCHAR(20),
  email VARCHAR(150),
  address TEXT,
  photo_url TEXT,
  fingerprint_hash TEXT,
  kyc_status VARCHAR(20) NOT NULL DEFAULT 'pending',
  classification VARCHAR(40), -- free-form tag (risk tier / product eligibility / susu classification) — deliberately not a CHECK-constrained enum, see Decisions_Log.md
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT customers_type_chk CHECK (customer_type IN ('individual', 'group', 'sme')),
  CONSTRAINT customers_kyc_status_chk CHECK (kyc_status IN ('pending', 'verified', 'rejected')),
  CONSTRAINT customers_status_chk CHECK (status IN ('active', 'inactive', 'closed'))
);

CREATE INDEX ON customers (branch_id);
CREATE INDEX ON customers (customer_type);
CREATE INDEX ON customers (status);
CREATE INDEX ON customers (classification);

-- Ghana Card number unique across ACTIVE/INACTIVE customers, but NOT
-- against closed ones — "unique across active customers but allow
-- re-registration checks against closed accounts (fraud prevention)"
-- (Module 2 business rule). A plain UNIQUE constraint would permanently
-- block re-registration after closure; this partial index only guards
-- non-closed rows, while customerService.js separately surfaces any
-- closed-customer matches for fraud review rather than blocking on them.
CREATE UNIQUE INDEX customers_ghana_card_active_uq
  ON customers (ghana_card_no)
  WHERE ghana_card_no IS NOT NULL AND status <> 'closed';
