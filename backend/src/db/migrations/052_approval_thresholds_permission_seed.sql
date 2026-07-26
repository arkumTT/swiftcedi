-- Adds the permission gating the Admin Back Office's "Access & Approval
-- Rules" screen (approval_thresholds CRUD) — approval_thresholds has
-- existed since migration 003 but had no CRUD endpoint until the frontend
-- build needed one. Granted to owner + system_admin, same grain as
-- Module 8's compliance.manage_config: a genuine executive/technical
-- configuration action, not day-to-day branch-staff work.

INSERT INTO permissions (code, description) VALUES
  ('approval.manage_thresholds', 'Configure maker-checker amount thresholds per action type/branch');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name IN ('owner', 'system_admin') AND p.code = 'approval.manage_thresholds';
