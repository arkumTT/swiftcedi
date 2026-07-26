-- Module 3: the loan itself. `customer_id` always references `customers`
-- (Module 2) — for a group loan this is the group's OWN customer row
-- (customer_type = 'group'), the same "customers is the entity that holds
-- accounts" design Module 2 established; individual joint-liability
-- members of a group loan are captured separately in
-- loan_group_liabilities (migration 025).
--
-- interest_method/annual_interest_rate_bps are snapshotted from the
-- product at application time (not FK'd live) so a later product-rate
-- change never retroactively alters an existing loan's terms.

CREATE TABLE loans (
  id BIGSERIAL PRIMARY KEY,
  loan_type VARCHAR(20) NOT NULL,
  customer_id BIGINT NOT NULL REFERENCES customers(id),
  branch_id BIGINT NOT NULL REFERENCES branches(id),
  product_id BIGINT NOT NULL REFERENCES loan_products(id),
  principal_pesewas BIGINT NOT NULL,
  term_months INT NOT NULL,
  interest_method VARCHAR(20) NOT NULL,
  annual_interest_rate_bps INT NOT NULL,
  reason_code VARCHAR(60),
  purpose_notes TEXT,
  current_schedule_version INT NOT NULL DEFAULT 1,
  status VARCHAR(20) NOT NULL DEFAULT 'applied',
  applied_by BIGINT NOT NULL REFERENCES users(id),
  disbursed_at TIMESTAMPTZ,
  disbursed_by BIGINT REFERENCES users(id),
  disbursement_journal_entry_id BIGINT REFERENCES gl_journal_entries(id),
  closed_at TIMESTAMPTZ,
  written_off_at TIMESTAMPTZ,
  written_off_by BIGINT REFERENCES users(id),
  write_off_journal_entry_id BIGINT REFERENCES gl_journal_entries(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT loans_type_chk CHECK (loan_type IN ('individual', 'group', 'overdraft')),
  CONSTRAINT loans_interest_method_chk CHECK (interest_method IN ('flat', 'reducing_balance')),
  CONSTRAINT loans_principal_chk CHECK (principal_pesewas > 0),
  CONSTRAINT loans_term_chk CHECK (term_months > 0),
  CONSTRAINT loans_status_chk CHECK (
    status IN ('applied', 'appraised', 'pending_approval', 'approved', 'rejected', 'disbursed', 'closed', 'written_off')
  )
);

CREATE INDEX ON loans (customer_id);
CREATE INDEX ON loans (branch_id);
CREATE INDEX ON loans (product_id);
CREATE INDEX ON loans (status);

CREATE TABLE loan_appraisals (
  id BIGSERIAL PRIMARY KEY,
  loan_id BIGINT NOT NULL REFERENCES loans(id),
  appraiser_id BIGINT NOT NULL REFERENCES users(id),
  checklist JSONB NOT NULL,
  recommendation VARCHAR(20) NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT loan_appraisals_recommendation_chk CHECK (recommendation IN ('recommend', 'decline'))
);

CREATE INDEX ON loan_appraisals (loan_id);
