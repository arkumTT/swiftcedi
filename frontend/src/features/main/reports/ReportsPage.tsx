import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../../auth/AuthContext';
import { isCrossBranchRole } from '../../../lib/roleScope';
import { api, ApiError } from '../../../lib/apiClient';
import { useBranches, useStaff } from '../../../lib/adminHooks';
import { Card } from '../../../components/Card';
import { DataTable, type Column } from '../../../components/DataTable';
import { KpiCard } from '../../../components/KpiCard';
import { ErrorState } from '../../../components/ErrorState';
import { selectClasses } from '../../../components/FormField';
import { formatGhs, formatDate } from '../../../lib/format';
import { PaymentTrendChart } from './PaymentTrendChart';
import type {
  ExecutiveReportPack,
  TrialBalance,
  BalanceSheet,
  IncomeStatement,
  GlAccountLine,
  LoanProduct,
  RepaymentBreakdown,
} from '../../../types/api';

type Statement = 'trial-balance' | 'balance-sheet' | 'income-statement';
type PaymentGranularity = 'day' | 'week' | 'month';

interface ModeBreakdownRow {
  paymentModeId: number | null;
  code: string | null;
  name: string;
  count: number;
  totalPesewas: number;
}
interface ReceiverBreakdownRow {
  receiverUserId: number | null;
  receiverName: string;
  count: number;
  totalPesewas: number;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
function monthsAgoIso(n: number) {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 10);
}

export function ReportsPage() {
  const { user, hasPermission } = useAuth();
  const crossBranch = isCrossBranchRole(user!.roleName);
  const { data: branches } = useBranches();
  const [branchId, setBranchId] = useState(crossBranch ? '' : user!.homeBranchId);
  const [statement, setStatement] = useState<Statement>('trial-balance');
  const [asOfDate, setAsOfDate] = useState(todayIso());
  const [fromDate, setFromDate] = useState(monthsAgoIso(1));

  const [paymentFromDate, setPaymentFromDate] = useState(monthsAgoIso(1));
  const [paymentToDate, setPaymentToDate] = useState(todayIso());
  const [paymentGranularity, setPaymentGranularity] = useState<PaymentGranularity>('day');
  const [paymentProductId, setPaymentProductId] = useState('');
  const [paymentLoanOfficerId, setPaymentLoanOfficerId] = useState('');

  const productsQuery = useQuery({ queryKey: ['loan-products'], queryFn: () => api.get<LoanProduct[]>('/loans/products') });
  const staffQuery = useStaff();
  const loanOfficers = (staffQuery.data ?? []).filter((s) => s.role_name === 'loan_officer');

  const repaymentBreakdownQuery = useQuery({
    queryKey: ['repayment-breakdown', { branchId, paymentFromDate, paymentToDate, paymentGranularity, paymentProductId, paymentLoanOfficerId }],
    queryFn: () =>
      api.get<RepaymentBreakdown>('/analytics/repayment-breakdown', {
        branchId: crossBranch ? branchId || 'all' : branchId,
        fromDate: paymentFromDate,
        toDate: paymentToDate,
        granularity: paymentGranularity,
        productId: paymentProductId || undefined,
        loanOfficerId: paymentLoanOfficerId || undefined,
      }),
    enabled: hasPermission('analytics.view'),
  });

  const modeColumns: Column<ModeBreakdownRow>[] = [
    { key: 'name', header: 'Payment mode', render: (r) => r.name },
    { key: 'count', header: 'Count', render: (r) => r.count, align: 'right' },
    { key: 'total', header: 'Total', render: (r) => formatGhs(r.totalPesewas), align: 'right' },
  ];
  const receiverColumns: Column<ReceiverBreakdownRow>[] = [
    { key: 'name', header: 'Receiver', render: (r) => r.receiverName },
    { key: 'count', header: 'Count', render: (r) => r.count, align: 'right' },
    { key: 'total', header: 'Total', render: (r) => formatGhs(r.totalPesewas), align: 'right' },
  ];

  const reportPackQuery = useQuery({
    queryKey: ['report-pack', { branchId, asOfDate, fromDate }],
    // 'all' is the resolveConsolidatedBranchScope sentinel (see
    // Decisions_Log.md) — omitting branchId would silently default to the
    // caller's OWN home branch even for a cross-branch owner/system_admin.
    queryFn: () => api.get<ExecutiveReportPack>('/analytics/report-pack', { branchId: crossBranch ? branchId || 'all' : branchId, asOfDate, fromDate, toDate: asOfDate }),
    enabled: hasPermission('analytics.view'),
  });

  const trialBalanceQuery = useQuery({
    queryKey: ['trial-balance', { branchId, asOfDate }],
    queryFn: () => api.get<TrialBalance>('/gl/reports/trial-balance', { branchId, asOfDate }),
    enabled: hasPermission('gl.view_reports') && statement === 'trial-balance',
  });
  const balanceSheetQuery = useQuery({
    queryKey: ['balance-sheet', { branchId, asOfDate }],
    queryFn: () => api.get<BalanceSheet>('/gl/reports/balance-sheet', { branchId, asOfDate }),
    enabled: hasPermission('gl.view_reports') && statement === 'balance-sheet',
  });
  const incomeStatementQuery = useQuery({
    queryKey: ['income-statement', { branchId, fromDate, asOfDate }],
    queryFn: () => api.get<IncomeStatement>('/gl/reports/income-statement', { branchId, fromDate, toDate: asOfDate }),
    enabled: hasPermission('gl.view_reports') && statement === 'income-statement',
  });

  const accountColumns: Column<GlAccountLine>[] = [
    { key: 'code', header: 'Code', render: (l) => l.code },
    { key: 'name', header: 'Account', render: (l) => l.name },
    ...(statement === 'trial-balance'
      ? ([
          { key: 'debit', header: 'Debit', render: (l: GlAccountLine) => (l.debitPesewas ? formatGhs(l.debitPesewas) : '—'), align: 'right' },
          { key: 'credit', header: 'Credit', render: (l: GlAccountLine) => (l.creditPesewas ? formatGhs(l.creditPesewas) : '—'), align: 'right' },
        ] as Column<GlAccountLine>[])
      : ([{ key: 'balance', header: 'Balance', render: (l: GlAccountLine) => formatGhs(l.balancePesewas), align: 'right' }] as Column<GlAccountLine>[])),
  ];

  const activeStatementRows: GlAccountLine[] =
    statement === 'trial-balance'
      ? trialBalanceQuery.data?.lines ?? []
      : statement === 'balance-sheet'
        ? [...(balanceSheetQuery.data?.assets ?? []), ...(balanceSheetQuery.data?.liabilities ?? []), ...(balanceSheetQuery.data?.equity ?? [])]
        : [...(incomeStatementQuery.data?.income ?? []), ...(incomeStatementQuery.data?.expense ?? [])];

  const statementError = statement === 'trial-balance' ? trialBalanceQuery.error : statement === 'balance-sheet' ? balanceSheetQuery.error : incomeStatementQuery.error;
  const statementLoading = statement === 'trial-balance' ? trialBalanceQuery.isLoading : statement === 'balance-sheet' ? balanceSheetQuery.isLoading : incomeStatementQuery.isLoading;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Reports & Analytics</h1>
          <p className="text-[13px] text-text-secondary">Executive summary and financial statements.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {crossBranch && (
            <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className={selectClasses + ' h-8 text-[12.5px]'}>
              <option value="">All branches</option>
              {branches?.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          )}
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="h-8 rounded-md border border-border bg-surface px-2.5 text-[12.5px] text-text-primary focus-visible:border-accent" />
          <input type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} className="h-8 rounded-md border border-border bg-surface px-2.5 text-[12.5px] text-text-primary focus-visible:border-accent" />
        </div>
      </div>

      {hasPermission('analytics.view') && (
        <Card title="Executive report pack">
          {reportPackQuery.error && (
            <ErrorState message={reportPackQuery.error instanceof ApiError ? reportPackQuery.error.message : 'Unable to load report pack'} onRetry={() => reportPackQuery.refetch()} />
          )}
          {reportPackQuery.data && (
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <KpiCard label="Total assets" value={formatGhs(reportPackQuery.data.balanceSheet.totalAssetsPesewas)} />
                <KpiCard label="Net income (period)" value={formatGhs(reportPackQuery.data.incomeStatement.netIncomePesewas)} />
                <KpiCard label="Loan portfolio" value={formatGhs(reportPackQuery.data.portfolioSummary.totalOutstandingPesewas)} />
                <KpiCard
                  label="PAR30"
                  value={reportPackQuery.data.portfolioSummary.par30.ratio != null ? `${(reportPackQuery.data.portfolioSummary.par30.ratio * 100).toFixed(1)}%` : '—'}
                  higherIsBetter={false}
                />
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <KpiCard label="Active borrowers" value={String(reportPackQuery.data.socialPerformance.activeBorrowerCount)} />
                <KpiCard label="Active susu participants" value={String(reportPackQuery.data.socialPerformance.activeSusuParticipants)} />
                <KpiCard label="Avg. loan size" value={formatGhs(reportPackQuery.data.socialPerformance.averageLoanSizePesewas)} />
                <KpiCard label="Active loans" value={String(reportPackQuery.data.portfolioSummary.loanCount)} />
              </div>
            </div>
          )}
        </Card>
      )}

      {hasPermission('gl.view_reports') && (
        <Card
          title="Financial statements"
          actions={
            <select value={statement} onChange={(e) => setStatement(e.target.value as Statement)} className={selectClasses + ' h-8 text-[12.5px]'}>
              <option value="trial-balance">Trial balance</option>
              <option value="balance-sheet">Balance sheet</option>
              <option value="income-statement">Income statement</option>
            </select>
          }
          padded={false}
        >
          {statement === 'trial-balance' && trialBalanceQuery.data && (
            <div className="flex gap-3 px-4 pt-3">
              <span className="text-[13px] text-text-secondary">Total debit: {formatGhs(trialBalanceQuery.data.totalDebitPesewas)}</span>
              <span className="text-[13px] text-text-secondary">Total credit: {formatGhs(trialBalanceQuery.data.totalCreditPesewas)}</span>
              <span className={`text-[13px] font-medium ${trialBalanceQuery.data.balanced ? 'text-success' : 'text-danger'}`}>
                {trialBalanceQuery.data.balanced ? 'Balanced' : 'Not balanced'}
              </span>
            </div>
          )}
          {statement === 'balance-sheet' && balanceSheetQuery.data && (
            <div className="flex gap-3 px-4 pt-3">
              <span className="text-[13px] text-text-secondary">Assets: {formatGhs(balanceSheetQuery.data.totalAssetsPesewas)}</span>
              <span className="text-[13px] text-text-secondary">Liabilities: {formatGhs(balanceSheetQuery.data.totalLiabilitiesPesewas)}</span>
              <span className="text-[13px] text-text-secondary">Equity + net income: {formatGhs(balanceSheetQuery.data.totalEquityAndNetIncomePesewas)}</span>
            </div>
          )}
          {statement === 'income-statement' && incomeStatementQuery.data && (
            <div className="flex gap-3 px-4 pt-3">
              <span className="text-[13px] text-text-secondary">Income: {formatGhs(incomeStatementQuery.data.totalIncomePesewas)}</span>
              <span className="text-[13px] text-text-secondary">Expense: {formatGhs(incomeStatementQuery.data.totalExpensePesewas)}</span>
              <span className="text-[13px] font-medium text-text-primary">Net: {formatGhs(incomeStatementQuery.data.netIncomePesewas)}</span>
            </div>
          )}
          {statementError ? (
            <ErrorState message={statementError instanceof ApiError ? statementError.message : 'Unable to load statement'} />
          ) : (
            <DataTable columns={accountColumns} rows={activeStatementRows} getRowKey={(l) => l.accountId} isLoading={statementLoading} emptyTitle="No activity for this period" />
          )}
        </Card>
      )}

      {hasPermission('analytics.view') && (
        <Card
          title="Repayment breakdown"
          actions={
            <div className="flex flex-wrap gap-2">
              <select value={paymentProductId} onChange={(e) => setPaymentProductId(e.target.value)} className={selectClasses + ' h-8 text-[12.5px]'}>
                <option value="">All loan offers</option>
                {productsQuery.data?.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <select value={paymentLoanOfficerId} onChange={(e) => setPaymentLoanOfficerId(e.target.value)} className={selectClasses + ' h-8 text-[12.5px]'}>
                <option value="">All agents</option>
                {loanOfficers.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.full_name}
                  </option>
                ))}
              </select>
              <select value={paymentGranularity} onChange={(e) => setPaymentGranularity(e.target.value as PaymentGranularity)} className={selectClasses + ' h-8 text-[12.5px]'}>
                <option value="day">Daily</option>
                <option value="week">Weekly</option>
                <option value="month">Monthly</option>
              </select>
              <input
                type="date"
                value={paymentFromDate}
                onChange={(e) => setPaymentFromDate(e.target.value)}
                className="h-8 rounded-md border border-border bg-surface px-2.5 text-[12.5px] text-text-primary focus-visible:border-accent"
              />
              <input
                type="date"
                value={paymentToDate}
                onChange={(e) => setPaymentToDate(e.target.value)}
                className="h-8 rounded-md border border-border bg-surface px-2.5 text-[12.5px] text-text-primary focus-visible:border-accent"
              />
            </div>
          }
        >
          {repaymentBreakdownQuery.error && (
            <ErrorState
              message={repaymentBreakdownQuery.error instanceof ApiError ? repaymentBreakdownQuery.error.message : 'Unable to load repayment breakdown'}
              onRetry={() => repaymentBreakdownQuery.refetch()}
            />
          )}
          {repaymentBreakdownQuery.data && (
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <KpiCard label="Total collected" value={formatGhs(repaymentBreakdownQuery.data.total.totalPesewas)} />
                <KpiCard label="Payments recorded" value={String(repaymentBreakdownQuery.data.total.count)} />
                {repaymentBreakdownQuery.data.byMode.map((m) => (
                  <KpiCard key={m.paymentModeId ?? m.name} label={m.name} value={formatGhs(m.totalPesewas)} />
                ))}
              </div>

              <PaymentTrendChart data={repaymentBreakdownQuery.data.trend.map((t) => ({ ...t, period: formatDate(t.period) }))} />

              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <div>
                  <p className="mb-1.5 text-[12.5px] font-semibold text-text-secondary">By payment mode</p>
                  <DataTable
                    columns={modeColumns}
                    rows={repaymentBreakdownQuery.data.byMode}
                    getRowKey={(r) => r.paymentModeId ?? r.name}
                    emptyTitle="No repayments in this range"
                  />
                </div>
                <div>
                  <p className="mb-1.5 text-[12.5px] font-semibold text-text-secondary">By receiver</p>
                  <DataTable
                    columns={receiverColumns}
                    rows={repaymentBreakdownQuery.data.byReceiver}
                    getRowKey={(r) => r.receiverUserId ?? r.receiverName}
                    emptyTitle="No repayments in this range"
                  />
                </div>
              </div>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
