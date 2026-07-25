-- Baseline permission codes for the capabilities this session implements.
-- Later modules add their own codes (e.g. 'loan.disburse') via the
-- permission CRUD endpoint rather than further migrations.

INSERT INTO permissions (code, description) VALUES
  ('audit.view', 'View audit log entries'),
  ('approval.request', 'Submit an action for maker-checker approval'),
  ('approval.decide', 'Approve or reject a pending approval request'),
  ('rbac.manage_roles', 'Create/update roles and role-permission assignments'),
  ('rbac.manage_users', 'Create/update users and role assignments'),
  ('gl.manage_accounts', 'Create/update chart of accounts'),
  ('gl.post_journal', 'Post a journal entry to the general ledger'),
  ('gl.view_reports', 'View GL reports (trial balance, balance sheet, income statement)');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p WHERE r.name = 'system_admin';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'owner' AND p.code IN ('audit.view', 'approval.decide', 'gl.view_reports');
