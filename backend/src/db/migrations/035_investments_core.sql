-- Module 5: fixed-term investment products for investors. Investors are
-- customers (Module 2's `customers` table — same "customer_type" pattern
-- used throughout, no separate investor identity), booked as a LIABILITY
-- against Investment Deposits Payable (migration 034) — see
-- Decisions_Log.md for why this is debt, not equity.
--
-- `investments` snapshots tenor/rate/payout_frequency/penalty from the
-- product at APPLICATION time (same reasoning as loans: a later product
-- edit must never retroactively alter an existing investment's terms).
-- `start_date`/`maturity_date` are set at ACTIVATION (when funds actually
-- move), not application, since that's when the accrual clock starts.

CREATE TABLE investment_products (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  code VARCHAR(20) UNIQUE NOT NULL,
  tenor_months INT NOT NULL,
  annual_interest_rate_bps INT NOT NULL,
  min_principal_pesewas BIGINT NOT NULL,
  max_principal_pesewas BIGINT,
  -- 'monthly': interest is paid out to the investor periodically via
  -- investment_payouts. 'at_maturity': interest accrues but is only paid
  -- out as part of redemption. The spec's examples ("monthly, at
  -- maturity, etc.") — other frequencies are a future extension, not
  -- guessed at here.
  payout_frequency VARCHAR(20) NOT NULL,
  -- Fraction (bps, 0-10000) of ACCRUED INTEREST forfeited on an early
  -- redemption. Principal is never penalized — see Decisions_Log.md.
  early_withdrawal_penalty_bps INT NOT NULL DEFAULT 0,
  -- Default periodic-payout approval threshold, same resolution order as
  -- Module 4's savings withdrawal threshold: a branch-specific
  -- approval_thresholds row for 'investment.payout' wins if present,
  -- otherwise this column. 0 means every payout needs approval — the
  -- safe default when nobody has configured a real threshold, not "no
  -- approval needed."  Redemptions ALWAYS need approval regardless of
  -- this column — see investment_redemptions.
  payout_approval_threshold_pesewas BIGINT NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT investment_products_status_chk CHECK (status IN ('active', 'inactive')),
  CONSTRAINT investment_products_payout_frequency_chk CHECK (payout_frequency IN ('monthly', 'at_maturity')),
  CONSTRAINT investment_products_tenor_chk CHECK (tenor_months > 0),
  CONSTRAINT investment_products_rate_chk CHECK (annual_interest_rate_bps >= 0),
  CONSTRAINT investment_products_principal_chk CHECK (
    min_principal_pesewas > 0 AND (max_principal_pesewas IS NULL OR max_principal_pesewas >= min_principal_pesewas)
  ),
  CONSTRAINT investment_products_penalty_chk CHECK (early_withdrawal_penalty_bps BETWEEN 0 AND 10000),
  CONSTRAINT investment_products_payout_threshold_chk CHECK (payout_approval_threshold_pesewas >= 0)
);

CREATE TABLE investments (
  id BIGSERIAL PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers(id),
  branch_id BIGINT NOT NULL REFERENCES branches(id),
  product_id BIGINT NOT NULL REFERENCES investment_products(id),
  principal_pesewas BIGINT NOT NULL,
  tenor_months INT NOT NULL,
  annual_interest_rate_bps INT NOT NULL,
  payout_frequency VARCHAR(20) NOT NULL,
  early_withdrawal_penalty_bps INT NOT NULL,
  start_date DATE,
  maturity_date DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'applied',
  applied_by BIGINT NOT NULL REFERENCES users(id),
  activated_at TIMESTAMPTZ,
  activated_by BIGINT REFERENCES users(id),
  booking_journal_entry_id BIGINT REFERENCES gl_journal_entries(id),
  redeemed_at TIMESTAMPTZ,
  redeemed_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT investments_principal_chk CHECK (principal_pesewas > 0),
  CONSTRAINT investments_status_chk CHECK (
    status IN ('applied', 'pending_approval', 'rejected', 'approved', 'active', 'matured', 'redeemed')
  )
);

CREATE INDEX ON investments (customer_id);
CREATE INDEX ON investments (branch_id);
CREATE INDEX ON investments (product_id);
CREATE INDEX ON investments (status);

-- Append-only. Unlike loan_repayments/savings_transactions, this needs no
-- two-phase journal_entry_id stamp: the service posts the GL entry FIRST
-- (glPosting.postJournalEntry doesn't depend on this row existing), then
-- inserts this row with journal_entry_id already known. UNIQUE(investment_id,
-- accrual_date) blocks double-accruing the same day.
CREATE TABLE investment_accruals (
  id BIGSERIAL PRIMARY KEY,
  investment_id BIGINT NOT NULL REFERENCES investments(id),
  accrual_date DATE NOT NULL,
  principal_balance_pesewas BIGINT NOT NULL,
  interest_pesewas BIGINT NOT NULL,
  journal_entry_id BIGINT NOT NULL REFERENCES gl_journal_entries(id),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT investment_accruals_principal_chk CHECK (principal_balance_pesewas > 0),
  CONSTRAINT investment_accruals_interest_chk CHECK (interest_pesewas > 0),
  CONSTRAINT investment_accruals_one_per_day UNIQUE (investment_id, accrual_date)
);

CREATE INDEX ON investment_accruals (investment_id);

CREATE OR REPLACE FUNCTION prevent_investment_accruals_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'investment_accruals is immutable: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_investment_accruals_immutable
  BEFORE UPDATE OR DELETE ON investment_accruals
  FOR EACH ROW EXECUTE FUNCTION prevent_investment_accruals_mutation();

-- Periodic interest payouts (for 'monthly' payout_frequency products).
-- Threshold-gated maker-checker, same convention as Module 4's
-- withdrawal_requests: below the configured approval_thresholds row for
-- 'investment.payout', pays out immediately; at/above it, queues for
-- approval.
CREATE TABLE investment_payouts (
  id BIGSERIAL PRIMARY KEY,
  investment_id BIGINT NOT NULL REFERENCES investments(id),
  amount_pesewas BIGINT NOT NULL,
  threshold_flag BOOLEAN NOT NULL,
  approval_request_id BIGINT UNIQUE REFERENCES approval_requests(id),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  -- Manually-entered MoMo/bank reference or cashier voucher number once
  -- paid — there is no live payments integration yet, see Decisions_Log.md.
  payment_reference VARCHAR(120),
  journal_entry_id BIGINT REFERENCES gl_journal_entries(id),
  requested_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT investment_payouts_amount_chk CHECK (amount_pesewas > 0),
  CONSTRAINT investment_payouts_status_chk CHECK (status IN ('pending', 'paid', 'rejected')),
  CONSTRAINT investment_payouts_approval_chk CHECK (threshold_flag = false OR approval_request_id IS NOT NULL)
);

CREATE INDEX ON investment_payouts (investment_id);
CREATE INDEX ON investment_payouts (status);

-- Redemptions ("disinvestments") — early or at-maturity — ALWAYS require
-- maker-checker approval (the module spec's "pending-approval queue for
-- new investments and disinvestments", no threshold escape hatch, same
-- treatment as loan.approve). At most one redemption per investment ever
-- (UNIQUE investment_id) since redemption is terminal.
--
-- Never marks `paid` optimistically: `status` goes pending -> approved ->
-- paid, and `paid` is only reachable through an explicit confirmation
-- step recording a payment_reference — modeling "the payment layer
-- confirms the transfer succeeded" as a manual staff confirmation until a
-- real payments integration lands (see Decisions_Log.md's "BEFORE YOU
-- WRITE CODE" resolution).
CREATE TABLE investment_redemptions (
  id BIGSERIAL PRIMARY KEY,
  investment_id BIGINT NOT NULL UNIQUE REFERENCES investments(id),
  is_early BOOLEAN NOT NULL,
  principal_pesewas BIGINT NOT NULL,
  accrued_interest_pesewas BIGINT NOT NULL,
  penalty_pesewas BIGINT NOT NULL DEFAULT 0,
  interest_payable_pesewas BIGINT NOT NULL,
  total_payout_pesewas BIGINT NOT NULL,
  approval_request_id BIGINT NOT NULL UNIQUE REFERENCES approval_requests(id),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  payment_reference VARCHAR(120),
  journal_entry_id BIGINT REFERENCES gl_journal_entries(id),
  requested_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT investment_redemptions_principal_chk CHECK (principal_pesewas > 0),
  CONSTRAINT investment_redemptions_accrued_chk CHECK (accrued_interest_pesewas >= 0),
  CONSTRAINT investment_redemptions_penalty_chk CHECK (penalty_pesewas >= 0 AND penalty_pesewas <= accrued_interest_pesewas),
  CONSTRAINT investment_redemptions_interest_payable_chk CHECK (interest_payable_pesewas = accrued_interest_pesewas - penalty_pesewas),
  CONSTRAINT investment_redemptions_total_chk CHECK (total_payout_pesewas = principal_pesewas + interest_payable_pesewas),
  CONSTRAINT investment_redemptions_status_chk CHECK (status IN ('pending', 'approved', 'paid', 'rejected'))
);

CREATE INDEX ON investment_redemptions (investment_id);
CREATE INDEX ON investment_redemptions (status);
