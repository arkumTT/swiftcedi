-- Module 5: permission codes for investment management. 'investment.request_payout'
-- and 'investment.request_redemption' each cover BOTH requesting the
-- action and settling/confirming it once approved — same reuse pattern
-- Module 4 established for 'savings.withdraw' (request + settle share one
-- permission).

INSERT INTO permissions (code, description) VALUES
  ('investment.manage_products', 'Create/update investment products'),
  ('investment.book', 'Book a new investment application (requests maker-checker approval)'),
  ('investment.activate', 'Activate an approved investment (posts the GL entry, starts accrual)'),
  ('investment.accrue_interest', 'Accrue interest on an active investment (scheduler/staff-facing)'),
  ('investment.request_payout', 'Request/settle a periodic interest payout'),
  ('investment.request_redemption', 'Request/confirm a redemption (disinvestment), early or at maturity'),
  ('investment.view', 'View investment products, investments, and investor statements');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p WHERE r.name = 'system_admin' AND p.code LIKE 'investment.%';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'owner'
  AND p.code IN ('investment.manage_products', 'investment.activate', 'investment.request_redemption', 'investment.view');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'branch_manager'
  AND p.code IN ('investment.book', 'investment.activate', 'investment.accrue_interest',
                 'investment.request_payout', 'investment.request_redemption', 'investment.view');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'loan_officer'
  AND p.code IN ('investment.book', 'investment.request_payout', 'investment.view');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'cashier'
  AND p.code IN ('investment.request_payout', 'investment.view');
