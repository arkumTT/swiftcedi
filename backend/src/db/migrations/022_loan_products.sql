-- Module 3: loan product configuration. Interest rate is stored as
-- integer basis points of the ANNUAL nominal rate (e.g. 2400 = 24% p.a.)
-- to avoid floats; loanService.js always amortizes on a MONTHLY schedule
-- (annual rate / 12), which covers the overwhelming majority of
-- microfinance loan products and keeps the interest math tractable — see
-- Decisions_Log.md.

CREATE TABLE loan_products (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  code VARCHAR(20) UNIQUE NOT NULL,
  loan_type VARCHAR(20) NOT NULL,
  interest_method VARCHAR(20) NOT NULL,
  annual_interest_rate_bps INT NOT NULL,
  min_term_months INT NOT NULL,
  max_term_months INT NOT NULL,
  min_principal_pesewas BIGINT NOT NULL,
  max_principal_pesewas BIGINT NOT NULL,
  -- [{ code, type: 'flat'|'percent_of_principal', amountPesewas?, rateBps? }, ...]
  -- charged once, netted from the disbursed amount — see Decisions_Log.md.
  fee_schedule JSONB NOT NULL DEFAULT '[]',
  -- Ascending day-boundaries for arrears aging buckets, e.g. {30,60,90}
  -- produces buckets "1-30", "31-60", "61-90", "90+". These are portfolio
  -- management buckets, NOT the BOG prudential loan classification
  -- categories (current/OLEM/substandard/doubtful/loss) — that's Module 8.
  par_bucket_days INT[] NOT NULL DEFAULT '{30,60,90}',
  reason_codes TEXT[] NOT NULL DEFAULT '{}',
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT loan_products_loan_type_chk CHECK (loan_type IN ('individual', 'group', 'overdraft')),
  CONSTRAINT loan_products_interest_method_chk CHECK (interest_method IN ('flat', 'reducing_balance')),
  CONSTRAINT loan_products_status_chk CHECK (status IN ('active', 'inactive')),
  CONSTRAINT loan_products_rate_chk CHECK (annual_interest_rate_bps >= 0),
  CONSTRAINT loan_products_term_chk CHECK (min_term_months > 0 AND max_term_months >= min_term_months),
  CONSTRAINT loan_products_principal_chk CHECK (min_principal_pesewas > 0 AND max_principal_pesewas >= min_principal_pesewas)
);
