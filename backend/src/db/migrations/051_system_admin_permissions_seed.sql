-- Module 12 permissions. Granted to system_admin ONLY, no owner grant —
-- unlike Module 8's compliance work (which had genuine executive-
-- oversight duties this codebase's role set has no better fit for),
-- scheduling/archiving/backups/calendar config are purely technical
-- operations with a role that already exists and matches exactly:
-- 'system_admin'.

INSERT INTO permissions (code, description) VALUES
  ('sysadmin.manage_jobs', 'Create/update scheduled jobs, trigger them manually, and view run history'),
  ('sysadmin.manage_calendar', 'Configure the working-days/holiday calendar'),
  ('sysadmin.manage_archiving', 'Configure archive policies and run archive sweeps'),
  ('sysadmin.manage_backups', 'Trigger database backups/restores and export data'),
  ('sysadmin.manage_subscriptions', 'Manage subscription/licence records');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p WHERE r.name = 'system_admin' AND p.code LIKE 'sysadmin.%';
