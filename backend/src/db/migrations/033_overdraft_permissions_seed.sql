-- Module 3: permission codes for overdraft servicing. Applying for an
-- overdraft and disbursing/activating it reuse the existing 'loan.apply'
-- and 'loan.disburse' permissions (activateOverdraft is dispatched from
-- the same disburseLoan()/POST /:id/disburse entry point — see
-- Decisions_Log.md) — these two are for the actions that have no
-- equivalent among the existing loan permissions.

INSERT INTO permissions (code, description) VALUES
  ('loan.accrue_overdraft_interest', 'Accrue and post interest on a drawn overdraft facility (scheduler/staff-facing)'),
  ('loan.close_overdraft', 'Close an overdraft facility once its drawn balance is repaid');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'system_admin' AND p.code IN ('loan.accrue_overdraft_interest', 'loan.close_overdraft');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'branch_manager' AND p.code IN ('loan.accrue_overdraft_interest', 'loan.close_overdraft');
