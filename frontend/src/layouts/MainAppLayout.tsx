import {
  LayoutDashboard,
  Users,
  Landmark,
  PiggyBank,
  TrendingUp,
  Wallet,
  Receipt,
  Building2,
  MapPinned,
  BarChart3,
  ShieldAlert,
} from 'lucide-react';
import type { NavGroup } from '../components/Sidebar';
import { AppShell } from './AppShell';

// Section 7.3's navigation map (full/Owner view) — items are permission-
// gated per Section 7.2's role scope table, so a loan officer/cashier/agent
// naturally sees only their own slice without a second, role-specific nav
// config to maintain.
const NAV_GROUPS: NavGroup[] = [
  {
    items: [{ to: '/app', label: 'Dashboard', icon: LayoutDashboard }],
  },
  {
    label: 'Customers & credit',
    items: [
      { to: '/app/customers', label: 'Customers & CRM', icon: Users, anyOf: ['customer.create', 'customer.update', 'customer.verify_kyc'] },
      { to: '/app/loans', label: 'Loans & Credit', icon: Landmark, anyOf: ['loan.apply', 'loan.appraise', 'loan.disburse', 'loan.view_reports'] },
    ],
  },
  {
    label: 'Deposits & investments',
    items: [
      { to: '/app/savings', label: 'Savings & Susu', icon: PiggyBank, anyOf: ['savings.view', 'susu.view', 'susu.record_collection'] },
      { to: '/app/investments', label: 'Investments', icon: TrendingUp, anyOf: ['investment.view', 'investment.book'] },
    ],
  },
  {
    label: 'Operations',
    items: [
      { to: '/app/cashier', label: 'Cashier & Vault', icon: Wallet, anyOf: ['cashier.view'] },
      { to: '/app/transactions', label: 'Transactions', icon: Receipt, anyOf: ['gl.view_reports', 'cashier.view', 'loan.view_reports'] },
      { to: '/app/branches', label: 'Branches', icon: Building2, anyOf: ['branch.view_performance'] },
      { to: '/app/agents', label: 'Field Agents', icon: MapPinned, anyOf: ['agent.manage', 'agent.view_locations', 'agent.ping_location'] },
    ],
  },
  {
    label: 'Insight & oversight',
    items: [
      { to: '/app/reports', label: 'Reports & Analytics', icon: BarChart3, anyOf: ['analytics.view', 'gl.view_reports'] },
      { to: '/app/compliance', label: 'Compliance & Regulatory', icon: ShieldAlert, anyOf: ['compliance.generate_reports', 'compliance.manage_aml', 'compliance.manage_sanctions'] },
    ],
  },
];

export function MainAppLayout() {
  return (
    <AppShell
      navGroups={NAV_GROUPS}
      brand={{ label: 'SwiftCedi', sublabel: 'Banking Platform' }}
      settingsPath="/app/settings"
      collapseStorageKey="swiftcedi.app.sidebarCollapsed"
    />
  );
}

export { NAV_GROUPS as MAIN_APP_NAV_GROUPS };
