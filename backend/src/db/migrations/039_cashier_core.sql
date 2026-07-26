-- Module 6: cashier till/vault operations.
--
-- No new GL control accounts are needed — till float and cash-back both
-- move cash between the branch's EXISTING Cash in Hand (1000.<branch>)
-- and Vault (1010.<branch>) sub-accounts, both established in Module 1.
-- Deliberately no `vault_balances` table either (the spec's data model
-- lists one): "the vault balance" for a branch already IS
-- `branch_gl_accounts.vault_account_id`'s reconstructed GL balance
-- (`glPosting.getAccountBalance`) — a parallel stored-balance table would
-- just be a second, driftable copy of the same number. See
-- Decisions_Log.md.
--
-- Similarly, no separate `deleted_transactions_log` table: nothing in
-- this codebase ever hard-deletes a financial record already (every
-- module's tables are either append-only with an immutability trigger,
-- or use a status/soft-delete column), and every write already goes
-- through the shared `audit_log` service. A parallel deletion-log table
-- would violate CLAUDE.md's "route all audit writes through the shared
-- audit-log service — do not write ad hoc audit logic per module." See
-- Decisions_Log.md's Deviations.

CREATE TABLE cashier_tills (
  id BIGSERIAL PRIMARY KEY,
  branch_id BIGINT NOT NULL REFERENCES branches(id),
  cashier_id BIGINT NOT NULL REFERENCES users(id),
  business_date DATE NOT NULL,
  opening_balance_pesewas BIGINT NOT NULL,
  closing_balance_pesewas BIGINT,
  -- opening_balance + every 'paid' cash_back_requests amount for this
  -- till, computed at close time — what SHOULD be in the drawer, given
  -- ordinary teller transactions aren't attributed to a specific till in
  -- this schema (ordinary deposits/withdrawals/disbursements post to the
  -- branch's pooled Cash in Hand, not a till_id) — see Decisions_Log.md.
  expected_closing_balance_pesewas BIGINT,
  variance_pesewas BIGINT,
  denomination_breakdown_open JSONB,
  denomination_breakdown_close JSONB,
  status VARCHAR(20) NOT NULL DEFAULT 'open',
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  opened_by BIGINT NOT NULL REFERENCES users(id),
  opening_journal_entry_id BIGINT REFERENCES gl_journal_entries(id),
  closed_at TIMESTAMPTZ,
  closed_by BIGINT REFERENCES users(id),
  closing_journal_entry_id BIGINT REFERENCES gl_journal_entries(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cashier_tills_opening_chk CHECK (opening_balance_pesewas >= 0),
  CONSTRAINT cashier_tills_closing_chk CHECK (closing_balance_pesewas IS NULL OR closing_balance_pesewas >= 0),
  CONSTRAINT cashier_tills_status_chk CHECK (status IN ('open', 'closed'))
);

CREATE INDEX ON cashier_tills (branch_id);
CREATE INDEX ON cashier_tills (cashier_id);
CREATE INDEX ON cashier_tills (status);

-- Threshold-gated maker-checker, same convention as Module 4's
-- withdrawal_requests / Module 5's investment_payouts: below the
-- configured approval_thresholds row for 'cashback.request', pays out
-- immediately; at/above it, queues for approval.
CREATE TABLE cash_back_requests (
  id BIGSERIAL PRIMARY KEY,
  till_id BIGINT NOT NULL REFERENCES cashier_tills(id),
  amount_pesewas BIGINT NOT NULL,
  threshold_flag BOOLEAN NOT NULL,
  approval_request_id BIGINT UNIQUE REFERENCES approval_requests(id),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  journal_entry_id BIGINT REFERENCES gl_journal_entries(id),
  requested_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cash_back_requests_amount_chk CHECK (amount_pesewas > 0),
  CONSTRAINT cash_back_requests_status_chk CHECK (status IN ('pending', 'paid', 'rejected')),
  CONSTRAINT cash_back_requests_approval_chk CHECK (threshold_flag = false OR approval_request_id IS NOT NULL)
);

CREATE INDEX ON cash_back_requests (till_id);
CREATE INDEX ON cash_back_requests (status);

-- Reversals ALWAYS require maker-checker (no threshold — the spec's own
-- "reversed-transaction handling (with a reason code and approver)" reads
-- as always-approved, same treatment as loan.approve /
-- investment.book/redeem). At most one reversal per original entry —
-- enforced again here (defense in depth alongside gl_journal_entries'
-- own UNIQUE(reverses_entry_id) from migration 037).
CREATE TABLE transaction_reversals (
  id BIGSERIAL PRIMARY KEY,
  branch_id BIGINT NOT NULL REFERENCES branches(id),
  original_journal_entry_id BIGINT NOT NULL UNIQUE REFERENCES gl_journal_entries(id),
  reason_code VARCHAR(60) NOT NULL,
  notes TEXT,
  approval_request_id BIGINT NOT NULL UNIQUE REFERENCES approval_requests(id),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  reversal_journal_entry_id BIGINT REFERENCES gl_journal_entries(id),
  requested_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT transaction_reversals_status_chk CHECK (status IN ('pending', 'approved', 'reversed', 'rejected'))
);

CREATE INDEX ON transaction_reversals (branch_id);
CREATE INDEX ON transaction_reversals (status);

-- Day/month/year close-out. Every level shares the SAME precondition per
-- the spec ("close-out endpoints ... each validating all tills for the
-- branch are closed first") — no open cashier_tills for the branch,
-- regardless of level. Month/year close-out ALSO creates (and locks) the
-- corresponding `gl_periods` row (migration 006, Module 7) — activating
-- a period-lock mechanism that has existed since Module 7 but had no
-- producer until now, so glPosting.postJournalEntry's existing period-
-- lock check finally takes real effect for every module's postings, not
-- just cashier operations. 'day' has no gl_periods equivalent (that table
-- only supports month/year), so a day close is a procedural/audit lock
-- only — enforced by cashierService checking for an existing 'day'
-- snapshot covering a date before allowing new till opens/closes on it.
CREATE TABLE day_close_snapshots (
  id BIGSERIAL PRIMARY KEY,
  branch_id BIGINT NOT NULL REFERENCES branches(id),
  period_type VARCHAR(10) NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  locked BOOLEAN NOT NULL DEFAULT true,
  cash_in_hand_balance_pesewas BIGINT NOT NULL,
  vault_balance_pesewas BIGINT NOT NULL,
  tills_closed_count INT NOT NULL DEFAULT 0,
  gl_period_id BIGINT REFERENCES gl_periods(id),
  closed_by BIGINT NOT NULL REFERENCES users(id),
  closed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT day_close_snapshots_period_type_chk CHECK (period_type IN ('day', 'month', 'year')),
  CONSTRAINT day_close_snapshots_unique UNIQUE (branch_id, period_type, period_start)
);

CREATE INDEX ON day_close_snapshots (branch_id);
