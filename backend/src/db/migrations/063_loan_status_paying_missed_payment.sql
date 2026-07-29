-- Loan module amendment (item 5): adds 'paying' and 'missed_payment' as
-- loans.status values, sub-states of what 'disbursed' used to be the
-- resting status for. 'disbursed' itself is UNCHANGED as the status
-- disburseLoan/activateOverdraft sets at the moment of disbursement; for
-- an ordinary (non-overdraft) loan it now immediately advances to
-- 'paying' or 'missed_payment' the first time loanService recomputes it
-- (see loanService.refreshLoanStatus), based on whether any schedule
-- installment is unpaid past the offer's installment_grace_period_days.
-- Overdraft facilities (no installment schedule) are deliberately never
-- recomputed and stay on 'disbursed' for their whole active life, exactly
-- as before this migration.
--
-- This is a DB-enforced value-set change only — no data migration is
-- needed since no existing row can already hold either new value.
--
-- IMPORTANT cross-module consequence (see Decisions_Log.md "Loan module
-- amendment" for the full list): every existing `status = 'disbursed'`
-- filter that means "this loan is currently active/open" (analyticsService,
-- complianceService, systemAdminService, and loanService's own
-- postRepayment/requestRestructure/writeOffLoan/getArrearsReport guards)
-- is updated in the same commit as this migration to instead match
-- `status IN ('disbursed', 'paying', 'missed_payment')`, since a loan that
-- has ever been recomputed will almost never still read literally
-- 'disbursed'.

ALTER TABLE loans DROP CONSTRAINT loans_status_chk;
ALTER TABLE loans ADD CONSTRAINT loans_status_chk CHECK (
  status IN (
    'applied', 'appraised', 'pending_approval', 'approved', 'rejected',
    'disbursed', 'paying', 'missed_payment', 'closed', 'written_off'
  )
);
