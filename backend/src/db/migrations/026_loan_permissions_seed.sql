-- Module 3: permission codes for loan management.

INSERT INTO permissions (code, description) VALUES
  ('loan.manage_products', 'Create/update loan products'),
  ('loan.apply', 'Submit a loan application'),
  ('loan.appraise', 'Submit a loan appraisal checklist'),
  ('loan.request_approval', 'Request maker-checker approval for a loan'),
  ('loan.disburse', 'Disburse an approved loan (posts the GL entry)'),
  ('loan.post_repayment', 'Post a repayment against a loan'),
  ('loan.restructure', 'Request a loan restructure (maker-checker gated)'),
  ('loan.write_off', 'Write off a loan as a bad debt'),
  ('loan.manage_collateral', 'Attach/verify loan collateral'),
  ('loan.manage_guarantors', 'Attach/verify loan guarantors'),
  ('loan.view_reports', 'View arrears/aging and portfolio reports');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p WHERE r.name = 'system_admin' AND p.code LIKE 'loan.%';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'owner'
  AND p.code IN ('loan.manage_products', 'loan.disburse', 'loan.write_off', 'loan.view_reports');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'branch_manager'
  AND p.code IN ('loan.disburse', 'loan.write_off', 'loan.view_reports', 'loan.manage_collateral', 'loan.manage_guarantors');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'loan_officer'
  AND p.code IN ('loan.apply', 'loan.appraise', 'loan.request_approval', 'loan.restructure', 'loan.manage_collateral', 'loan.manage_guarantors', 'loan.view_reports');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'cashier'
  AND p.code IN ('loan.post_repayment');
