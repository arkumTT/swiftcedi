import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../../auth/AuthContext';
import { isCrossBranchRole } from '../../../lib/roleScope';
import { api, ApiError } from '../../../lib/apiClient';
import { useBranches } from '../../../lib/adminHooks';
import { Card } from '../../../components/Card';
import { DataTable, type Column } from '../../../components/DataTable';
import { KpiCard } from '../../../components/KpiCard';
import { ErrorState } from '../../../components/ErrorState';
import { selectClasses } from '../../../components/FormField';
import { formatGhs } from '../../../lib/format';
import type { ExecutiveReportPack, TrialBalance, BalanceSheet, IncomeStatement, GlAccountLine } from '../../../types/api';

type Statement = 'trial-balance' | 'balance-sheet' | 'income-statement';

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
    </div>
  );
}
