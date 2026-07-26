-- Module 7 additions: manual-JV request (maker-checker) and bank
-- reconciliation each get their own permission code, same granularity as
-- the original gl.manage_accounts/gl.post_journal/gl.view_reports split.
-- Scoped to the exact new codes (not `LIKE 'gl.%'`) since migration 008
-- already granted system_admin every gl.* code that existed at the time --
-- re-matching the whole prefix here would re-insert those same
-- (role_id, permission_id) pairs and violate role_permissions' PK.

INSERT INTO permissions (code, description) VALUES
  ('gl.request_manual_jv', 'Request a manual journal-voucher entry (requires approval before posting)'),
  ('gl.reconcile_bank', 'Register bank accounts for reconciliation, import statement lines, and match/reconcile them against the GL');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'system_admin' AND p.code IN ('gl.request_manual_jv', 'gl.reconcile_bank');
