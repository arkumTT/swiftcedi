import { Navigate, Route, Routes } from 'react-router-dom';
import { LoginPage } from './auth/LoginPage';
import { RequireAuth, RequirePermission } from './auth/RequireAuth';
import { AdminLayout } from './layouts/AdminLayout';
import { MainAppLayout } from './layouts/MainAppLayout';
import { PlaceholderPage } from './components/PlaceholderPage';
import { SettingsPage } from './features/settings/SettingsPage';
import { UsersRolesPage } from './features/admin/UsersRolesPage';
import { RolesPermissionsPage } from './features/admin/RolesPermissionsPage';
import { AccessApprovalRulesPage } from './features/admin/AccessApprovalRulesPage';
import { BranchesAdminPage } from './features/admin/BranchesAdminPage';
import { RegulatoryTemplatesPage } from './features/admin/RegulatoryTemplatesPage';
import { SystemJobsPage } from './features/admin/SystemJobsPage';
import { AuditLogPage } from './features/admin/AuditLogPage';
import { BackupsDataPage } from './features/admin/BackupsDataPage';
import { SystemHealthPage } from './features/admin/SystemHealthPage';
import { DashboardPage } from './features/main/dashboard/DashboardPage';
import { CustomersListPage } from './features/main/customers/CustomersListPage';
import { Customer360Page } from './features/main/customers/Customer360Page';
import { LoansListPage } from './features/main/loans/LoansListPage';
import { LoanDetailPage } from './features/main/loans/LoanDetailPage';
import { SavingsSusuPage } from './features/main/savings/SavingsSusuPage';
import { SavingsAccountDetailPage } from './features/main/savings/SavingsAccountDetailPage';
import { SusuAccountDetailPage } from './features/main/savings/SusuAccountDetailPage';
import { InvestmentsListPage } from './features/main/investments/InvestmentsListPage';
import { InvestmentDetailPage } from './features/main/investments/InvestmentDetailPage';
import { CashierVaultPage } from './features/main/cashier/CashierVaultPage';
import { TillDetailPage } from './features/main/cashier/TillDetailPage';
import { TransactionsPage } from './features/main/transactions/TransactionsPage';
import { BranchesPage } from './features/main/branches/BranchesPage';
import { BranchDetailPage } from './features/main/branches/BranchDetailPage';

const ADMIN_ANY_OF = [
  'rbac.manage_users',
  'rbac.manage_roles',
  'branch.create',
  'compliance.manage_config',
  'sysadmin.manage_jobs',
  'audit.view',
  'sysadmin.manage_backups',
];

function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route
        path="/admin"
        element={
          <RequireAuth>
            <RequirePermission anyOf={ADMIN_ANY_OF}>
              <AdminLayout />
            </RequirePermission>
          </RequireAuth>
        }
      >
        <Route index element={<Navigate to="users" replace />} />
        <Route
          path="users"
          element={
            <RequirePermission anyOf={['rbac.manage_users']}>
              <UsersRolesPage />
            </RequirePermission>
          }
        />
        <Route
          path="roles-permissions"
          element={
            <RequirePermission anyOf={['rbac.manage_roles']}>
              <RolesPermissionsPage />
            </RequirePermission>
          }
        />
        <Route
          path="access-rules"
          element={
            <RequirePermission anyOf={['approval.manage_thresholds', 'branch.manage_staff']}>
              <AccessApprovalRulesPage />
            </RequirePermission>
          }
        />
        <Route
          path="branches"
          element={
            <RequirePermission anyOf={['branch.create', 'branch.update']}>
              <BranchesAdminPage />
            </RequirePermission>
          }
        />
        <Route
          path="regulatory-templates"
          element={
            <RequirePermission anyOf={['compliance.manage_config', 'compliance.generate_reports']}>
              <RegulatoryTemplatesPage />
            </RequirePermission>
          }
        />
        <Route
          path="jobs"
          element={
            <RequirePermission anyOf={['sysadmin.manage_jobs']}>
              <SystemJobsPage />
            </RequirePermission>
          }
        />
        <Route
          path="audit-log"
          element={
            <RequirePermission anyOf={['audit.view']}>
              <AuditLogPage />
            </RequirePermission>
          }
        />
        <Route
          path="backups"
          element={
            <RequirePermission anyOf={['sysadmin.manage_backups']}>
              <BackupsDataPage />
            </RequirePermission>
          }
        />
        <Route
          path="system-health"
          element={
            <RequirePermission anyOf={['sysadmin.manage_jobs']}>
              <SystemHealthPage />
            </RequirePermission>
          }
        />
        <Route path="settings" element={<SettingsPage />} />
      </Route>

      <Route
        path="/app"
        element={
          <RequireAuth>
            <MainAppLayout />
          </RequireAuth>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="customers" element={<CustomersListPage />} />
        <Route path="customers/:id" element={<Customer360Page />} />
        <Route path="loans" element={<LoansListPage />} />
        <Route path="loans/:id" element={<LoanDetailPage />} />
        <Route path="savings" element={<SavingsSusuPage />} />
        <Route path="savings/accounts/:id" element={<SavingsAccountDetailPage />} />
        <Route path="savings/susu/:id" element={<SusuAccountDetailPage />} />
        <Route path="investments" element={<InvestmentsListPage />} />
        <Route path="investments/:id" element={<InvestmentDetailPage />} />
        <Route path="cashier" element={<CashierVaultPage />} />
        <Route path="cashier/tills/:id" element={<TillDetailPage />} />
        <Route path="transactions" element={<TransactionsPage />} />
        <Route path="branches" element={<BranchesPage />} />
        <Route path="branches/:id" element={<BranchDetailPage />} />
        <Route path="agents" element={<PlaceholderPage title="Field Agents" />} />
        <Route path="reports" element={<PlaceholderPage title="Reports & Analytics" />} />
        <Route path="compliance" element={<PlaceholderPage title="Compliance & Regulatory" />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/app" replace />} />
    </Routes>
  );
}

export default App;
