-- Module 6: permission codes for cashier/till/vault operations.
-- 'cashier.request_cashback' and 'cashier.request_reversal' each cover
-- BOTH requesting the action and settling/executing it once approved —
-- same reuse pattern Module 4 established for 'savings.withdraw'.

INSERT INTO permissions (code, description) VALUES
  ('cashier.till_open', 'Open a cashier till with an opening float'),
  ('cashier.till_close', 'Close a cashier till and record the counted closing balance'),
  ('cashier.request_cashback', 'Request/settle a cash-back (additional float from the vault)'),
  ('cashier.request_reversal', 'Request/execute a reversal of a posted GL transaction'),
  ('cashier.close_out', 'Run a day/month/year branch close-out'),
  ('cashier.adjust_prior_period', 'Request/post a back-dated adjustment into a locked period'),
  ('cashier.view', 'View tills, cash-back/reversal requests, close-outs, and cash position');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p WHERE r.name = 'system_admin' AND p.code LIKE 'cashier.%';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'owner'
  AND p.code IN ('cashier.close_out', 'cashier.adjust_prior_period', 'cashier.view');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'branch_manager'
  AND p.code IN ('cashier.till_open', 'cashier.till_close', 'cashier.request_cashback', 'cashier.request_reversal',
                 'cashier.close_out', 'cashier.adjust_prior_period', 'cashier.view');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'cashier'
  AND p.code IN ('cashier.till_open', 'cashier.till_close', 'cashier.request_cashback', 'cashier.view');
