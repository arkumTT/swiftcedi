-- Tracks whether an installment's default charge has already been
-- auto-applied (see loanService.refreshLoanStatus), so re-reading a loan
-- repeatedly never charges it twice for the same missed installment.
-- The charge amount itself lives in the pre-existing fees_due_pesewas
-- column (always 0 until now — fee_schedule fees are charged once at
-- disbursement, never per-installment, so this column was otherwise
-- unused), collected through the same fees-then-interest-then-principal
-- allocateRepayment waterfall every other fee already goes through.
-- Waiving a charge (loanService.waiveDefaultCharge) reduces
-- fees_due_pesewas directly rather than introducing a second parallel
-- ledger column — the audit_log entry it writes (before/after
-- fees_due_pesewas) is the durable record of the waiver, consistent with
-- how every other financial adjustment in this codebase is recorded.

ALTER TABLE loan_schedules ADD COLUMN default_charge_applied BOOLEAN NOT NULL DEFAULT false;
