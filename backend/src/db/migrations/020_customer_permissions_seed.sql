-- Module 2: permission codes for customer/CRM management.

INSERT INTO permissions (code, description) VALUES
  ('customer.create', 'Onboard a new customer (individual, group, or SME)'),
  ('customer.update', 'Update a customer''s details'),
  ('customer.close', 'Request closure of a customer account (maker-checker gated)'),
  ('customer.reactivate', 'Reactivate an inactive customer account'),
  ('customer.classify', 'Assign a segmentation/classification tag to a customer'),
  ('customer.transfer_branch', 'Move a customer''s home branch'),
  ('customer.manage_documents', 'Attach/manage a customer''s KYC documents'),
  ('customer.manage_next_of_kin', 'Attach/manage a customer''s next-of-kin records'),
  ('customer.credit_bureau_lookup', 'Trigger a credit bureau lookup for a customer'),
  ('customer.verify_kyc', 'Set a customer''s KYC review outcome (pending/verified/rejected)'),
  ('group.manage_members', 'Add/remove group members and set the group leader');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p WHERE r.name = 'system_admin' AND p.code LIKE 'customer.%';
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p WHERE r.name = 'system_admin' AND p.code = 'group.manage_members';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'owner'
  AND p.code IN ('customer.create', 'customer.update', 'customer.close', 'customer.reactivate', 'customer.transfer_branch', 'customer.classify');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'branch_manager'
  AND p.code IN ('customer.update', 'customer.close', 'customer.reactivate', 'customer.transfer_branch', 'customer.classify', 'customer.manage_documents', 'customer.manage_next_of_kin', 'customer.credit_bureau_lookup', 'customer.verify_kyc', 'group.manage_members');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'loan_officer'
  AND p.code IN ('customer.create', 'customer.update', 'customer.classify', 'customer.manage_documents', 'customer.manage_next_of_kin', 'customer.credit_bureau_lookup', 'customer.verify_kyc', 'group.manage_members');
