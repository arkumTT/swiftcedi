-- Permission codes for the loan concessions / policy rates feature, plus
-- the RBAC change that feature actually requires to function under the
-- confirmed design (branch_manager as the concession approver, no new
-- role): branch_manager did not previously hold 'approval.decide' at
-- all (only owner/system_admin did, per migration 008 — a loan.approve
-- or loan.restructure request could structurally only ever be decided
-- by an owner/system_admin before this). Granting it is a prerequisite
-- for branch_manager to reach POST /approvals/:id/decide for ANY
-- action_type, not just concessions; which specific action_types they
-- may actually decide stays governed by approval_thresholds'
-- required_approver_role_id exactly as before — this migration also
-- seeds that threshold row for 'loan.grant_concession' pinned to
-- branch_manager. See Decisions_Log.md for the full reasoning and the
-- flagged side effect (branch_manager can now also decide loan.approve/
-- loan.restructure requests, which had no required-role threshold
-- configured and were previously reachable by owner/system_admin only).

INSERT INTO permissions (code, description) VALUES
  ('loan.grant_concession', 'Propose a negotiated rate/term/fee concession against a loan''s standard product terms'),
  ('loan.manage_policy_rates', 'Create/update reference (policy) rates that floating loan products link to');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'system_admin' AND p.code IN ('loan.grant_concession', 'loan.manage_policy_rates');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'owner' AND p.code = 'loan.manage_policy_rates';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'loan_officer' AND p.code = 'loan.grant_concession';

-- branch_manager becomes an approval.decide holder (see comment above).
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'branch_manager' AND p.code = 'approval.decide';

-- Pin branch_manager as the required approver for concessions that need
-- one — amount_threshold_pesewas is unused for this action_type
-- (loanService.requestConcession decides whether approval is needed
-- itself, from the product's concession_approval_threshold_bps, a
-- basis-points delta rather than a currency amount) so it's set to 0;
-- this row exists purely to pin required_approver_role_id.
INSERT INTO approval_thresholds (action_type, amount_threshold_pesewas, required_approver_role_id)
SELECT 'loan.grant_concession', 0, r.id FROM roles r WHERE r.name = 'branch_manager';
