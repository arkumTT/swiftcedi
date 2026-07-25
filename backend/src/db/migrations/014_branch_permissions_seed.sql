-- Module 1: permission codes for branch management, granted to the roles
-- that plausibly need them out of the box. Individual grants remain
-- adjustable later via POST /rbac/roles/:roleId/permissions.

INSERT INTO permissions (code, description) VALUES
  ('branch.create', 'Create a new branch (auto-generates its GL sub-accounts)'),
  ('branch.update', 'Update branch details (name, address, hierarchy, hours)'),
  ('branch.change_status', 'Transition a branch''s status (suspend/reactivate/review/close)'),
  ('branch.manage_staff', 'Assign staff to a branch and manage cross-branch access grants'),
  ('branch.manage_vault_config', 'Configure a branch''s opening float and daily cash limits'),
  ('branch.transfer', 'Initiate, confirm, or cancel a branch-to-branch cash transfer'),
  ('branch.view_performance', 'View branch performance/dashboard figures');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p WHERE r.name = 'system_admin' AND p.code LIKE 'branch.%';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'owner'
  AND p.code IN ('branch.create', 'branch.update', 'branch.change_status', 'branch.view_performance', 'branch.transfer');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'branch_manager'
  AND p.code IN ('branch.view_performance', 'branch.manage_staff', 'branch.transfer');
