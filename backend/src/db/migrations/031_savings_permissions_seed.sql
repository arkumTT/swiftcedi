-- Module 4: permission codes for savings, susu, and standing orders.

INSERT INTO permissions (code, description) VALUES
  ('savings.manage_products', 'Create/update savings products'),
  ('savings.open_account', 'Open a savings account for a customer'),
  ('savings.close_account', 'Close a savings account'),
  ('savings.deposit', 'Post a deposit to a savings account'),
  ('savings.withdraw', 'Request/pay out a withdrawal from a savings account'),
  ('savings.apply_charges', 'Apply maintenance/minimum-balance charges'),
  ('savings.view', 'View savings accounts, balances, and statements'),
  ('susu.manage_accounts', 'Create/close susu accounts'),
  ('susu.record_collection', 'Record a field susu collection (agent-facing)'),
  ('susu.remit', 'Record an agent remitting field cash to the branch'),
  ('susu.complete_cycle', 'Close a susu cycle and pay out proceeds'),
  ('susu.view', 'View susu accounts, collections, and commissions'),
  ('standing_order.manage', 'Create/update/cancel standing orders'),
  ('standing_order.execute', 'Execute due standing orders (scheduler-facing)');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'system_admin' AND (p.code LIKE 'savings.%' OR p.code LIKE 'susu.%' OR p.code LIKE 'standing_order.%');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'owner'
  AND p.code IN ('savings.manage_products', 'savings.view', 'susu.view', 'savings.close_account');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'branch_manager'
  AND p.code IN ('savings.open_account', 'savings.close_account', 'savings.apply_charges', 'savings.view',
                 'susu.manage_accounts', 'susu.remit', 'susu.complete_cycle', 'susu.view', 'standing_order.manage');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'cashier'
  AND p.code IN ('savings.deposit', 'savings.withdraw', 'savings.view', 'susu.remit', 'susu.view');

-- Field agents record collections in the field; they do NOT get
-- savings.deposit or savings.withdraw — they never handle a till.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'field_agent'
  AND p.code IN ('susu.record_collection', 'susu.view');
