import { Navigate, Route, Routes } from 'react-router-dom';
import { LoginPage } from './auth/LoginPage';
import { RequireAuth, RequirePermission } from './auth/RequireAuth';
import { AdminLayout } from './layouts/AdminLayout';
import { MainAppLayout } from './layouts/MainAppLayout';
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
import { FieldAgentsPage } from './features/main/agents/FieldAgentsPage';
import { FieldAgentDetailPage } from './features/main/agents/FieldAgentDetailPage';
import { ReportsPage } from './features/main/reports/ReportsPage';
import { CompliancePage } from './features/main/compliance/CompliancePage';

const ADMIN_ANY_OF = [
  'rbac.manage_users',
  'rbac.manage_roles',
  'branch.create',
  'compliance.manage_config',
  'sysadmin.manage_jobs',
  'audit.view',
  'sysadmin.manage_backups',
];

// Mirrors each nav item's `anyOf` in MainAppLayout.tsx exactly — a role that
// can't see a link in the sidebar must also be blocked from reaching the
// same screen by typing the URL directly, with the same honest "you don't
// have access" message RequirePermission already gives Admin routes,
// instead of the page silently firing 403 API calls.
const CUSTOMERS_ANY_OF = ['customer.create', 'customer.update', 'customer.verify_kyc'];
const LOANS_ANY_OF = ['loan.apply', 'loan.appraise', 'loan.disburse', 'loan.view_reports'];
const SAVINGS_ANY_OF = ['savings.view', 'susu.view', 'susu.record_collection'];
const INVESTMENTS_ANY_OF = ['investment.view', 'investment.book'];
const CASHIER_ANY_OF = ['cashier.view'];
const TRANSACTIONS_ANY_OF = ['gl.view_reports'];
const BRANCHES_ANY_OF = ['branch.view_performance'];
const AGENTS_ANY_OF = ['agent.manage', 'agent.view_locations', 'agent.ping_location'];
const REPORTS_ANY_OF = ['analytics.view', 'gl.view_reports'];
const COMPLIANCE_ANY_OF = ['compliance.generate_reports', 'compliance.manage_aml', 'compliance.manage_sanctions'];

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
        <Route
          path="customers"
          element={<RequirePermission anyOf={CUSTOMERS_ANY_OF}><CustomersListPage /></RequirePermission>}
        />
        <Route
          path="customers/:id"
          element={<RequirePermission anyOf={CUSTOMERS_ANY_OF}><Customer360Page /></RequirePermission>}
        />
        <Route path="loans" element={<RequirePermission anyOf={LOANS_ANY_OF}><LoansListPage /></RequirePermission>} />
        <Route
          path="loans/:id"
          element={<RequirePermission anyOf={LOANS_ANY_OF}><LoanDetailPage /></RequirePermission>}
        />
        <Route
          path="savings"
          element={<RequirePermission anyOf={SAVINGS_ANY_OF}><SavingsSusuPage /></RequirePermission>}
        />
        <Route
          path="savings/accounts/:id"
          element={<RequirePermission anyOf={SAVINGS_ANY_OF}><SavingsAccountDetailPage /></RequirePermission>}
        />
        <Route
          path="savings/susu/:id"
          element={<RequirePermission anyOf={SAVINGS_ANY_OF}><SusuAccountDetailPage /></RequirePermission>}
        />
        <Route
          path="investments"
          element={<RequirePermission anyOf={INVESTMENTS_ANY_OF}><InvestmentsListPage /></RequirePermission>}
        />
        <Route
          path="investments/:id"
          element={<RequirePermission anyOf={INVESTMENTS_ANY_OF}><InvestmentDetailPage /></RequirePermission>}
        />
        <Route
          path="cashier"
          element={<RequirePermission anyOf={CASHIER_ANY_OF}><CashierVaultPage /></RequirePermission>}
        />
        <Route
          path="cashier/tills/:id"
          element={<RequirePermission anyOf={CASHIER_ANY_OF}><TillDetailPage /></RequirePermission>}
        />
        <Route
          path="transactions"
          element={<RequirePermission anyOf={TRANSACTIONS_ANY_OF}><TransactionsPage /></RequirePermission>}
        />
        <Route
          path="branches"
          element={<RequirePermission anyOf={BRANCHES_ANY_OF}><BranchesPage /></RequirePermission>}
        />
        <Route
          path="branches/:id"
          element={<RequirePermission anyOf={BRANCHES_ANY_OF}><BranchDetailPage /></RequirePermission>}
        />
        <Route path="agents" element={<RequirePermission anyOf={AGENTS_ANY_OF}><FieldAgentsPage /></RequirePermission>} />
        <Route
          path="agents/:id"
          element={<RequirePermission anyOf={AGENTS_ANY_OF}><FieldAgentDetailPage /></RequirePermission>}
        />
        <Route path="reports" element={<RequirePermission anyOf={REPORTS_ANY_OF}><ReportsPage /></RequirePermission>} />
        <Route
          path="compliance"
          element={<RequirePermission anyOf={COMPLIANCE_ANY_OF}><CompliancePage /></RequirePermission>}
        />
        <Route path="settings" element={<SettingsPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/app" replace />} />
    </Routes>
  );
}

export default App;
