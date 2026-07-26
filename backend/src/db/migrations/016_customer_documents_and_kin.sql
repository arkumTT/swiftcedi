-- Module 2: KYC document references (URLs, not blobs, in Postgres) and
-- next-of-kin. A customer may have multiple documents and multiple
-- next-of-kin entries.

CREATE TABLE customer_documents (
  id BIGSERIAL PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers(id),
  document_type VARCHAR(40) NOT NULL, -- e.g. 'ghana_card_scan', 'photo', 'signed_agreement', 'fingerprint'
  file_url TEXT NOT NULL,
  uploaded_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON customer_documents (customer_id);

CREATE TABLE next_of_kin (
  id BIGSERIAL PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers(id),
  full_name VARCHAR(150) NOT NULL,
  relationship VARCHAR(60),
  phone VARCHAR(20),
  address TEXT,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON next_of_kin (customer_id);
