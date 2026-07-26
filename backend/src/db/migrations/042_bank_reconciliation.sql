-- Module 7: bank reconciliation. Deliberately does NOT auto-create a bank
-- GL sub-account per branch the way cash-in-hand/vault/cash-in-transit do
-- (branchService.js's CONTROL_ACCOUNT_CODES/createSubAccount pattern) --
-- unlike cash and a vault, not every branch necessarily holds its own bank
-- account (some institutions keep a single HQ-level operating account), so
-- registering one is an explicit, occasional admin action rather than
-- something every branch needs at creation time. Finance staff first create
-- the underlying asset account via the existing chart-of-accounts endpoints
-- (POST /gl/accounts, branchId optional/parentAccountId as appropriate),
-- then register it here as a reconcilable bank account.

CREATE TABLE bank_accounts (
  id BIGSERIAL PRIMARY KEY,
  gl_account_id BIGINT NOT NULL UNIQUE REFERENCES gl_accounts(id),
  branch_id BIGINT REFERENCES branches(id), -- NULL = HQ/consolidated bank account
  bank_name VARCHAR(120) NOT NULL,
  account_number VARCHAR(60) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT bank_accounts_status_chk CHECK (status IN ('active', 'inactive'))
);

-- Imported/entered external bank statement lines awaiting matching against
-- this institution's own GL journal lines for the same bank_account. Signed
-- from the bank's own point of view: positive = money the bank recorded as
-- coming in (deposit/credit), negative = money going out (withdrawal/debit)
-- -- which lines up directly with `normalizeBalance('asset', debit, credit)`
-- since a bank account is a debit-normal asset, so a matched GL journal
-- line's (debit_pesewas - credit_pesewas) must equal the statement line's
-- amount_pesewas exactly.
CREATE TABLE bank_statement_lines (
  id BIGSERIAL PRIMARY KEY,
  bank_account_id BIGINT NOT NULL REFERENCES bank_accounts(id),
  statement_date DATE NOT NULL,
  description TEXT NOT NULL,
  amount_pesewas BIGINT NOT NULL,
  external_reference VARCHAR(120),
  matched_journal_line_id BIGINT REFERENCES gl_journal_lines(id),
  status VARCHAR(20) NOT NULL DEFAULT 'unmatched',
  uploaded_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT bank_statement_lines_status_chk CHECK (status IN ('unmatched', 'matched')),
  CONSTRAINT bank_statement_lines_matched_chk CHECK ((status = 'matched') = (matched_journal_line_id IS NOT NULL))
);

CREATE INDEX ON bank_statement_lines (bank_account_id);
CREATE INDEX ON bank_statement_lines (status);
-- A GL journal line can settle at most one statement line.
CREATE UNIQUE INDEX bank_statement_lines_matched_journal_line_uidx
  ON bank_statement_lines (matched_journal_line_id)
  WHERE matched_journal_line_id IS NOT NULL;
