-- Module 10 permissions. 'agent.ping_location' is deliberately its own
-- narrow code (not folded into 'agent.manage') since it's the ONE action
-- an ordinary field_agent-role user needs for themselves — everything
-- else here is supervisor-facing.

INSERT INTO permissions (code, description) VALUES
  ('agent.manage', 'Create/update field agents and their branch/territory assignment history'),
  ('agent.ping_location', 'Submit a GPS location ping for the caller''s own field-agent record'),
  ('agent.view_locations', 'View current and historical field-agent GPS locations'),
  ('agent.reconcile', 'Run end-of-day agent cash reconciliation and resolve flagged variances');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p WHERE r.name = 'system_admin' AND p.code LIKE 'agent.%';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'branch_manager' AND p.code IN ('agent.manage', 'agent.view_locations', 'agent.reconcile');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'owner' AND p.code IN ('agent.view_locations', 'agent.reconcile');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'field_agent' AND p.code = 'agent.ping_location';
