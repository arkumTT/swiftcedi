-- Loan module amendment (item 6): the confirmed loan.approve design is
-- TIERED by amount — a request under GHS 100,000 is decidable by
-- branch_manager OR loan_officer, GHS 100,000 and above by owner OR
-- system_admin — which the pre-existing approval_thresholds table
-- couldn't represent at all: it only ever held ONE threshold row per
-- (action_type, branch), so getApplicableThreshold() could not pick a
-- different required-role set depending on the request's own amount.
--
-- Relaxes the row-per-(action_type,branch) uniqueness to
-- row-per-(action_type,branch,amount_threshold_pesewas), so a single
-- action_type can now have multiple TIER rows, distinguished by their own
-- amount_threshold_pesewas. approvalWorkflow.getApplicableThreshold is
-- updated in the same commit as this migration to pick the highest tier
-- whose amount_threshold_pesewas <= the request's amount (see that file's
-- comment) — every action_type that still only has one threshold row
-- (the overwhelming majority: savings.withdraw, gl.request_manual_jv,
-- loan.grant_concession, etc.) is completely unaffected by this, since
-- with only one row there's nothing to tier between.
--
-- Seeds loan.approve's two tiers (org-wide, no branch override):
--   lower tier: amount_threshold_pesewas = 0   -> branch_manager, loan_officer
--   upper tier: amount_threshold_pesewas = 10,000,000 (GHS 100,000) -> owner, system_admin
-- loanService.requestLoanApproval already passes the loan's own
-- principal as amountPesewas on every call (loan approval itself is
-- never threshold-gated on WHETHER approval is needed — every loan
-- requires it — only on WHO decides), so the lower tier's 0 threshold
-- guarantees a matching row for every loan amount.

ALTER TABLE approval_thresholds DROP CONSTRAINT IF EXISTS approval_thresholds_branch_action_uq;
DROP INDEX IF EXISTS approval_thresholds_branch_action_uq;
CREATE UNIQUE INDEX approval_thresholds_branch_action_amount_uq
  ON approval_thresholds (action_type, COALESCE(branch_id, 0), amount_threshold_pesewas);

INSERT INTO approval_thresholds (action_type, branch_id, amount_threshold_pesewas, required_approver_role_id, required_approver_role_ids)
SELECT 'loan.approve', NULL, 0,
       (SELECT id FROM roles WHERE name = 'branch_manager'),
       ARRAY[(SELECT id FROM roles WHERE name = 'branch_manager'), (SELECT id FROM roles WHERE name = 'loan_officer')];

INSERT INTO approval_thresholds (action_type, branch_id, amount_threshold_pesewas, required_approver_role_id, required_approver_role_ids)
SELECT 'loan.approve', NULL, 10000000,
       (SELECT id FROM roles WHERE name = 'owner'),
       ARRAY[(SELECT id FROM roles WHERE name = 'owner'), (SELECT id FROM roles WHERE name = 'system_admin')];
