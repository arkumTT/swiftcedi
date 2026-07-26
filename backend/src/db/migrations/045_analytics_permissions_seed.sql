-- Module 9 permissions. Coarse-grained by design, same grain as
-- 'gl.view_reports' covering five different report endpoints: 'analytics.view'
-- covers every read/report endpoint (live stats, portfolio quality,
-- profitability, growth trends, agent productivity, executive report pack);
-- 'analytics.manage_dashboards' is the separate, admin-level widget
-- config CRUD. Granted only to the three roles the module prompt actually
-- names ("ownership, branch managers, and loan officers") plus
-- system_admin — cashier/field_agent are not analytics audiences per the
-- prompt and get neither.
--
-- Branch/own-book scoping for branch_manager/loan_officer is enforced at
-- the query layer inside analyticsService.js (per the module prompt's own
-- explicit requirement), NOT by having a differently-scoped permission
-- code per role — same approach as every other branch-scoped permission
-- in this codebase (see Decisions_Log.md "Branch Scoping Convention").

INSERT INTO permissions (code, description) VALUES
  ('analytics.view', 'View analytics dashboards and reports (live stats, portfolio quality, profitability, growth trends, agent productivity, executive report pack)'),
  ('analytics.manage_dashboards', 'Create/update per-role dashboard widget configuration');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p WHERE r.name = 'system_admin' AND p.code LIKE 'analytics.%';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'owner' AND p.code IN ('analytics.view', 'analytics.manage_dashboards');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name IN ('branch_manager', 'loan_officer') AND p.code = 'analytics.view';
