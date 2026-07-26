-- Module 8 permissions. 'compliance.manage_config' covers every "define
-- the regulatory engine's parameters" action (loan classification
-- configs, ratio definitions, tax rates, report templates, AML rule
-- definitions, sanctions list entries) — system_admin only, same
-- technical/high-trust grain as 'gl.manage_accounts'. The other three are
-- the actual compliance WORK (generating reports, reviewing AML flags,
-- resolving sanctions matches), granted to owner too since this
-- codebase's role set has no dedicated compliance-officer role yet (see
-- Decisions_Log.md) and final regulatory accountability at a small MFI
-- sits with ownership.

INSERT INTO permissions (code, description) VALUES
  ('compliance.manage_config', 'Configure loan classification thresholds, regulatory ratio definitions, tax rates, and report templates'),
  ('compliance.generate_reports', 'Generate and view regulatory report submissions'),
  ('compliance.manage_aml', 'Configure AML rules, run screening, and review/clear flags'),
  ('compliance.manage_sanctions', 'Manage the sanctions list and resolve screening matches');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p WHERE r.name = 'system_admin' AND p.code LIKE 'compliance.%';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'owner' AND p.code IN ('compliance.generate_reports', 'compliance.manage_aml', 'compliance.manage_sanctions');
