-- Loan module amendment: permission for waiving an installment's default
-- charge (item 4's repayment-management action panel), and granting
-- loan_officer 'approval.decide' — required for the confirmed loan.approve
-- tiering (Decisions_Log.md): the LOWER tier (below GHS 100,000) is
-- decidable by branch_manager OR loan_officer, and loan_officer did not
-- previously hold 'approval.decide' at all (only owner/system_admin did
-- per migration 008, branch_manager added in migration 057 for
-- concessions) — granting it here is what lets a loan_officer reach
-- POST /approvals/:id/decide for ANY action_type they're the required
-- approver for, same flagged side effect migration 057 already noted for
-- branch_manager.

INSERT INTO permissions (code, description) VALUES
  ('loan.waive_charges', 'Waive an installment''s outstanding default charge');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name IN ('branch_manager', 'loan_officer', 'cashier') AND p.code = 'loan.waive_charges';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'loan_officer' AND p.code = 'approval.decide';
