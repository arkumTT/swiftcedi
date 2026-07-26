import {
  Users,
  ShieldCheck,
  Building2,
  KeyRound,
  FileCog,
  Clock,
  ScrollText,
  DatabaseBackup,
  Activity,
} from 'lucide-react';
import type { NavGroup } from '../components/Sidebar';
import { AppShell } from './AppShell';

// Section 6.2's navigation map, verbatim.
const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Identity & access',
    items: [
      { to: '/admin/users', label: 'Users & Roles', icon: Users, anyOf: ['rbac.manage_users'] },
      { to: '/admin/roles-permissions', label: 'Roles & Permissions', icon: ShieldCheck, anyOf: ['rbac.manage_roles'] },
      { to: '/admin/access-rules', label: 'Access & Approval Rules', icon: KeyRound, anyOf: ['approval.manage_thresholds', 'branch.manage_staff'] },
    ],
  },
  {
    label: 'Organization',
    items: [{ to: '/admin/branches', label: 'Branches', icon: Building2, anyOf: ['branch.create', 'branch.update'] }],
  },
  {
    label: 'Compliance & operations',
    items: [
      { to: '/admin/regulatory-templates', label: 'Regulatory Templates', icon: FileCog, anyOf: ['compliance.manage_config'] },
      { to: '/admin/jobs', label: 'System Jobs & Scheduler', icon: Clock, anyOf: ['sysadmin.manage_jobs'] },
      { to: '/admin/audit-log', label: 'Audit Log', icon: ScrollText, anyOf: ['audit.view'] },
      { to: '/admin/backups', label: 'Backups & Data', icon: DatabaseBackup, anyOf: ['sysadmin.manage_backups'] },
      { to: '/admin/system-health', label: 'System Health', icon: Activity, anyOf: ['sysadmin.manage_jobs'] },
    ],
  },
];

export function AdminLayout() {
  return (
    <AppShell
      navGroups={NAV_GROUPS}
      brand={{ label: 'SwiftCedi', sublabel: 'Admin Back Office' }}
      settingsPath="/admin/settings"
      collapseStorageKey="swiftcedi.admin.sidebarCollapsed"
    />
  );
}

export { NAV_GROUPS as ADMIN_NAV_GROUPS };
