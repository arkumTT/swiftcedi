-- Loan Products: FIXED vs FLOATING rate config, concession bounds, and
-- (declarative-only, see below) allowed repayment frequencies.
--
-- annual_interest_rate_bps (existing column) stays the SINGLE source of
-- "this product's current effective nominal annual rate" for BOTH fixed
-- and floating products — every existing consumer (applyForLoan's
-- snapshot, calculateLoan's preview, assertWithinProductLimits) already
-- reads it and needs no changes. For a FIXED product it's admin-set
-- directly, exactly as before. For a FLOATING product it becomes
-- system-maintained: reference_rate.rate_bps + spread_bps, recomputed
-- whenever the linked policy_rate changes or the product's own reset
-- job runs (loanService.resetFloatingRateProducts) — never edited
-- directly by an admin while rate_type = 'floating'.
--
-- min_rate_floor_bps / min_spread_floor_bps are the HARD bound a loan
-- officer's concession can never cross (loanService.requestConcession
-- rejects outright, no approval route, if breached) — min_rate_floor_bps
-- applies to a FIXED product's negotiated rate, min_spread_floor_bps to
-- a FLOATING product's negotiated spread (the officer can only ever
-- negotiate the bank's own margin, never the reference rate itself). A
-- NULL floor means concessions aren't permitted on that product at all.
--
-- concession_approval_threshold_bps is the SEPARATE soft threshold: a
-- concession still within the hard floor but discounting the rate/spread
-- by more than this many bps (or changing term/fees at all) requires
-- maker-checker approval before the loan can disburse; within the grace
-- window it applies immediately. Defaults to 0 (any concession at all
-- requires approval) — the conservative default for a banking app.
--
-- allowed_repayment_frequencies is genuinely configuration-only today:
-- loanMath.js's schedule generator is MONTHLY ONLY (a documented,
-- deliberate scope decision from Module 3's original build — see
-- Decisions_Log.md), and this migration does not change that. The CHECK
-- constraint restricts the array to {'monthly'} so this field records
-- real intent (a product CAN state it only offers monthly) without
-- silently implying weekly/biweekly repayment schedules actually work —
-- that would require changing loanMath.js's amortization engine, a
-- separate, larger change not undertaken here. See Decisions_Log.md.

ALTER TABLE loan_products
  ADD COLUMN rate_type VARCHAR(20) NOT NULL DEFAULT 'fixed',
  ADD COLUMN reference_rate_id BIGINT REFERENCES policy_rates(id),
  ADD COLUMN spread_bps INT,
  ADD COLUMN reset_frequency VARCHAR(20),
  ADD COLUMN last_reset_at DATE,
  ADD COLUMN min_rate_floor_bps INT,
  ADD COLUMN min_spread_floor_bps INT,
  ADD COLUMN concession_approval_threshold_bps INT NOT NULL DEFAULT 0,
  ADD COLUMN allowed_repayment_frequencies TEXT[] NOT NULL DEFAULT '{monthly}';

ALTER TABLE loan_products
  ADD CONSTRAINT loan_products_rate_type_chk CHECK (rate_type IN ('fixed', 'floating')),
  ADD CONSTRAINT loan_products_reset_frequency_chk
    CHECK (reset_frequency IS NULL OR reset_frequency IN ('monthly', 'quarterly', 'annually')),
  ADD CONSTRAINT loan_products_floating_fields_chk CHECK (
    (rate_type = 'fixed' AND reference_rate_id IS NULL AND spread_bps IS NULL AND reset_frequency IS NULL)
    OR
    (rate_type = 'floating' AND reference_rate_id IS NOT NULL AND spread_bps IS NOT NULL AND reset_frequency IS NOT NULL)
  ),
  ADD CONSTRAINT loan_products_rate_floor_chk CHECK (min_rate_floor_bps IS NULL OR min_rate_floor_bps >= 0),
  ADD CONSTRAINT loan_products_spread_floor_chk CHECK (min_spread_floor_bps IS NULL OR min_spread_floor_bps >= 0),
  ADD CONSTRAINT loan_products_concession_threshold_chk CHECK (concession_approval_threshold_bps >= 0),
  ADD CONSTRAINT loan_products_repayment_freq_chk
    CHECK (allowed_repayment_frequencies <@ ARRAY['monthly']::TEXT[]);

CREATE INDEX ON loan_products (reference_rate_id);
