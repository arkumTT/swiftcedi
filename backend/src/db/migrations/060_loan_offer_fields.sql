-- Loan module amendment (item 2): new required/optional configuration
-- fields on loan_products ("Loan Offer" in the UI — see Decisions_Log.md
-- for why the table/column names stay as-is while the UI label changed).
-- Interest Basis is NOT a new field — it's the existing interest_method
-- column (flat/reducing_balance), relabeled only; see Decisions_Log.md.
--
-- Processing fee / insurance fee / default charge each get a basis
-- ('flat' pesewas amount or 'percent_of_principal' rate in bps) plus
-- exactly one of an amount/rate column, mirroring the fixed/floating
-- nullable-pair pattern from migration 054 rather than overloading one
-- numeric column with two different units (pesewas vs bps) — that would
-- be exactly the kind of ambiguous-money-column this codebase's "never
-- use floats/ambiguous units for currency" rule exists to prevent.
--
-- Processing fee and default charge are REQUIRED on every offer (basis
-- defaults to 'flat' with a zero amount so existing rows stay valid
-- un-migrated); insurance fee is OPTIONAL (a NULL basis means "this offer
-- has no insurance fee" — all three insurance_fee_* columns NULL together).
--
-- repayment_grace_period_days and installment_grace_period_days are two
-- DIFFERENT things, both in days, and mixing them up is a real risk given
-- how similar they sound — kept clearly distinguished in every place they
-- appear (form helper text, code comments):
--   repayment_grace_period_days: days after DISBURSEMENT before the
--     borrower's first repayment obligation starts at all.
--   installment_grace_period_days: days after an individual installment's
--     OWN due date before that specific installment is considered missed
--     and eligible for a default charge / the loan's status can move to
--     'missed_payment' (see the status-enum migration).
--
-- duration_unit governs the UNIT that the existing min_term_months /
-- max_term_months bounds are expressed in (default 'months', the only
-- unit every pre-existing offer used, so no behavior changes for them).
-- An offer with duration_unit = 'days' or 'weeks' expresses those same
-- two bounds in days/weeks instead — the column names stay term_months
-- for backward compatibility (every existing consumer already reads
-- them), but their MEANING is now unit-relative; see loanService.js and
-- Decisions_Log.md for how application-time validation and schedule
-- generation account for this.
--
-- allowed_repayment_frequencies' CHECK is loosened from {'monthly'} only
-- to also allow daily/weekly/biweekly, now that loanMath.js's schedule
-- generator (see that file) has been extended to actually amortize on
-- those cadences too, closing the scope boundary migration 054's comment
-- flagged. The column's own default stays '{monthly}' — an existing
-- offer keeps behaving exactly as before until an admin opts it into
-- other cadences.

ALTER TABLE loan_products
  ADD COLUMN processing_fee_basis VARCHAR(20) NOT NULL DEFAULT 'flat',
  ADD COLUMN processing_fee_amount_pesewas BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN processing_fee_rate_bps INT,
  ADD COLUMN insurance_fee_basis VARCHAR(20),
  ADD COLUMN insurance_fee_amount_pesewas BIGINT,
  ADD COLUMN insurance_fee_rate_bps INT,
  ADD COLUMN default_charge_basis VARCHAR(20) NOT NULL DEFAULT 'flat',
  ADD COLUMN default_charge_amount_pesewas BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN default_charge_rate_bps INT,
  ADD COLUMN repayment_grace_period_days INT NOT NULL DEFAULT 0,
  ADD COLUMN installment_grace_period_days INT NOT NULL DEFAULT 0,
  ADD COLUMN duration_unit VARCHAR(10) NOT NULL DEFAULT 'months';

ALTER TABLE loan_products
  ADD CONSTRAINT loan_products_processing_fee_basis_chk CHECK (processing_fee_basis IN ('flat', 'percent_of_principal')),
  ADD CONSTRAINT loan_products_processing_fee_pair_chk CHECK (
    (processing_fee_basis = 'flat' AND processing_fee_rate_bps IS NULL AND processing_fee_amount_pesewas >= 0)
    OR
    (processing_fee_basis = 'percent_of_principal' AND processing_fee_rate_bps IS NOT NULL AND processing_fee_rate_bps >= 0)
  ),
  ADD CONSTRAINT loan_products_insurance_fee_basis_chk
    CHECK (insurance_fee_basis IS NULL OR insurance_fee_basis IN ('flat', 'percent_of_principal')),
  ADD CONSTRAINT loan_products_insurance_fee_pair_chk CHECK (
    (insurance_fee_basis IS NULL AND insurance_fee_amount_pesewas IS NULL AND insurance_fee_rate_bps IS NULL)
    OR
    (insurance_fee_basis = 'flat' AND insurance_fee_amount_pesewas >= 0 AND insurance_fee_rate_bps IS NULL)
    OR
    (insurance_fee_basis = 'percent_of_principal' AND insurance_fee_rate_bps >= 0 AND insurance_fee_amount_pesewas IS NULL)
  ),
  ADD CONSTRAINT loan_products_default_charge_basis_chk CHECK (default_charge_basis IN ('flat', 'percent_of_principal')),
  ADD CONSTRAINT loan_products_default_charge_pair_chk CHECK (
    (default_charge_basis = 'flat' AND default_charge_rate_bps IS NULL AND default_charge_amount_pesewas >= 0)
    OR
    (default_charge_basis = 'percent_of_principal' AND default_charge_rate_bps IS NOT NULL AND default_charge_rate_bps >= 0)
  ),
  ADD CONSTRAINT loan_products_repayment_grace_chk CHECK (repayment_grace_period_days >= 0),
  ADD CONSTRAINT loan_products_installment_grace_chk CHECK (installment_grace_period_days >= 0),
  ADD CONSTRAINT loan_products_duration_unit_chk CHECK (duration_unit IN ('days', 'weeks', 'months'));

ALTER TABLE loan_products DROP CONSTRAINT loan_products_repayment_freq_chk;
ALTER TABLE loan_products
  ADD CONSTRAINT loan_products_repayment_freq_chk
    CHECK (allowed_repayment_frequencies <@ ARRAY['daily', 'weekly', 'biweekly', 'monthly']::TEXT[]);
