-- Snapshots migration 060's new loan_products fields onto loans at
-- application time, same "past applications never silently change when
-- the offer is edited later" guarantee interest_method/rate/fee_schedule
-- already have (see migration 055's comment) — loanService.applyForLoan
-- is updated in the same commit as this migration to populate these from
-- the offer instead of ever reading them live later (e.g. at default-charge
-- time). Backfilled from each loan's product so no existing row is left
-- NULL.
--
-- repayment_frequency is NOT a product-level snapshot — it's the cadence
-- the APPLICANT chose at application time (item 3a), constrained to the
-- offer's own allowed_repayment_frequencies. duration_unit mirrors
-- loan_products.duration_unit (see migration 060) and governs what unit
-- loans.term_months is actually expressed in for this specific loan.

ALTER TABLE loans
  ADD COLUMN reference VARCHAR(40),
  ADD COLUMN repayment_frequency VARCHAR(10) NOT NULL DEFAULT 'monthly',
  ADD COLUMN duration_unit VARCHAR(10) NOT NULL DEFAULT 'months',
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
  ADD COLUMN installment_grace_period_days INT NOT NULL DEFAULT 0;

UPDATE loans l
   SET duration_unit = p.duration_unit,
       processing_fee_basis = p.processing_fee_basis,
       processing_fee_amount_pesewas = p.processing_fee_amount_pesewas,
       processing_fee_rate_bps = p.processing_fee_rate_bps,
       insurance_fee_basis = p.insurance_fee_basis,
       insurance_fee_amount_pesewas = p.insurance_fee_amount_pesewas,
       insurance_fee_rate_bps = p.insurance_fee_rate_bps,
       default_charge_basis = p.default_charge_basis,
       default_charge_amount_pesewas = p.default_charge_amount_pesewas,
       default_charge_rate_bps = p.default_charge_rate_bps,
       repayment_grace_period_days = p.repayment_grace_period_days,
       installment_grace_period_days = p.installment_grace_period_days
  FROM loan_products p
 WHERE l.product_id = p.id;

-- Backfill a reference for pre-existing loans using the same
-- <PREFIX>-<branchCode>-<sequence> shape loanService.generateLoanReference
-- produces going forward (see Decisions_Log.md), numbered by disbursement
-- order within each branch so the backfilled sequence is at least stable
-- and readable, even though it wasn't assigned at application time.
WITH numbered AS (
  SELECT l.id, b.code AS branch_code,
         ROW_NUMBER() OVER (PARTITION BY l.branch_id ORDER BY l.created_at, l.id) AS seq
    FROM loans l
    JOIN branches b ON b.id = l.branch_id
)
UPDATE loans l
   SET reference = 'LN-' || numbered.branch_code || '-' || LPAD(numbered.seq::text, 5, '0')
  FROM numbered
 WHERE l.id = numbered.id;

ALTER TABLE loans ALTER COLUMN reference SET NOT NULL;
ALTER TABLE loans ADD CONSTRAINT loans_reference_uq UNIQUE (reference);

ALTER TABLE loans
  ADD CONSTRAINT loans_repayment_frequency_chk CHECK (repayment_frequency IN ('daily', 'weekly', 'biweekly', 'monthly')),
  ADD CONSTRAINT loans_duration_unit_chk CHECK (duration_unit IN ('days', 'weeks', 'months')),
  ADD CONSTRAINT loans_processing_fee_basis_chk CHECK (processing_fee_basis IN ('flat', 'percent_of_principal')),
  ADD CONSTRAINT loans_processing_fee_pair_chk CHECK (
    (processing_fee_basis = 'flat' AND processing_fee_rate_bps IS NULL AND processing_fee_amount_pesewas >= 0)
    OR
    (processing_fee_basis = 'percent_of_principal' AND processing_fee_rate_bps IS NOT NULL AND processing_fee_rate_bps >= 0)
  ),
  ADD CONSTRAINT loans_insurance_fee_basis_chk
    CHECK (insurance_fee_basis IS NULL OR insurance_fee_basis IN ('flat', 'percent_of_principal')),
  ADD CONSTRAINT loans_insurance_fee_pair_chk CHECK (
    (insurance_fee_basis IS NULL AND insurance_fee_amount_pesewas IS NULL AND insurance_fee_rate_bps IS NULL)
    OR
    (insurance_fee_basis = 'flat' AND insurance_fee_amount_pesewas >= 0 AND insurance_fee_rate_bps IS NULL)
    OR
    (insurance_fee_basis = 'percent_of_principal' AND insurance_fee_rate_bps >= 0 AND insurance_fee_amount_pesewas IS NULL)
  ),
  ADD CONSTRAINT loans_default_charge_basis_chk CHECK (default_charge_basis IN ('flat', 'percent_of_principal')),
  ADD CONSTRAINT loans_default_charge_pair_chk CHECK (
    (default_charge_basis = 'flat' AND default_charge_rate_bps IS NULL AND default_charge_amount_pesewas >= 0)
    OR
    (default_charge_basis = 'percent_of_principal' AND default_charge_rate_bps IS NOT NULL AND default_charge_rate_bps >= 0)
  ),
  ADD CONSTRAINT loans_repayment_grace_chk CHECK (repayment_grace_period_days >= 0),
  ADD CONSTRAINT loans_installment_grace_chk CHECK (installment_grace_period_days >= 0);
