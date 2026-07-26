import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { useAuth } from '../../../auth/AuthContext';
import { api, ApiError } from '../../../lib/apiClient';
import { Card } from '../../../components/Card';
import { DataTable, type Column } from '../../../components/DataTable';
import { StatusBadge } from '../../../components/StatusBadge';
import { KpiCard } from '../../../components/KpiCard';
import { ErrorState } from '../../../components/ErrorState';
import { TrendChart, type TrendPoint } from '../dashboard/TrendChart';
import { formatDate, formatGhs } from '../../../lib/format';
import type { Branch, BranchPerformance, BranchStaffAssignment } from '../../../types/api';

interface PortfolioQuality {
  loanCount: number;
  totalOutstandingPesewas: number;
  par30: { atRiskPesewas: number; ratio: number | null };
  largestExposures: { loanId: number; outstandingPrincipalPesewas: number; daysOverdue: number }[];
}
interface GrowthTrends {
  disbursementTrend: { period: string; totalPesewas: number }[];
  depositGrowth: { period: string; netPesewas: number }[];
}

function monthsAgoIso(n: number) {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 10);
}
function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export function BranchDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();

  const branchQuery = useQuery({ queryKey: ['branch', id], queryFn: () => api.get<Branch>(`/branches/${id}`), enabled: Boolean(id) });
  const performanceQuery = useQuery({
    queryKey: ['branch-performance', id],
    queryFn: () => api.get<BranchPerformance>(`/branches/${id}/performance`),
    enabled: Boolean(id),
  });
  const portfolioQuery = useQuery({
    queryKey: ['branch-portfolio-quality', id],
    queryFn: () => api.get<PortfolioQuality>('/analytics/portfolio-quality', { branchId: id }),
    enabled: Boolean(id) && hasPermission('analytics.view'),
  });
  const growthQuery = useQuery({
    queryKey: ['branch-growth-trends', id],
    queryFn: () => api.get<GrowthTrends>('/analytics/growth-trends', { branchId: id, fromDate: monthsAgoIso(6), toDate: todayIso(), granularity: 'month' }),
    enabled: Boolean(id) && hasPermission('analytics.view'),
  });
  const staffQuery = useQuery({ queryKey: ['branch-staff', id], queryFn: () => api.get<BranchStaffAssignment[]>(`/branches/${id}/staff-assignments`), enabled: Boolean(id) });

  const trendData: TrendPoint[] = (() => {
    if (!growthQuery.data) return [];
    const byPeriod = new Map<string, TrendPoint>();
    for (const d of growthQuery.data.disbursementTrend) {
      byPeriod.set(d.period, { period: d.period.slice(0, 7), disbursedPesewas: d.totalPesewas, collectedPesewas: 0 });
    }
    for (const d of growthQuery.data.depositGrowth) {
      const existing = byPeriod.get(d.period);
      if (existing) existing.collectedPesewas = d.netPesewas;
      else byPeriod.set(d.period, { period: d.period.slice(0, 7), disbursedPesewas: 0, collectedPesewas: d.netPesewas });
    }
    return [...byPeriod.values()].sort((a, b) => a.period.localeCompare(b.period));
  })();

  if (branchQuery.isLoading) return <p className="p-4 text-[13px] text-text-secondary">Loading branch…</p>;
  if (branchQuery.error || !branchQuery.data) {
    return <ErrorState message={branchQuery.error instanceof ApiError ? branchQuery.error.message : 'Unable to load this branch'} onRetry={() => branchQuery.refetch()} />;
  }
  const branch = branchQuery.data;
  const perf = performanceQuery.data;

  const staffColumns: Column<BranchStaffAssignment>[] = [
    { key: 'user', header: 'User', render: (s) => `#${s.user_id}` },
    { key: 'start', header: 'Start date', render: (s) => formatDate(s.start_date) },
    { key: 'end', header: 'End date', render: (s) => (s.end_date ? formatDate(s.end_date) : 'Active') },
  ];

  return (
    <div className="flex flex-col gap-4">
      <button type="button" onClick={() => navigate('/app/branches')} className="flex w-fit items-center gap-1.5 text-[13px] text-text-secondary hover:text-text-primary">
        <ArrowLeft size={14} /> Back to branches
      </button>

      <Card>
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold text-text-primary">{branch.name}</h1>
          <span className="rounded-pill border border-border bg-surface-alt px-2 py-0.5 text-[11.5px] font-medium text-text-secondary">{branch.code}</span>
          <StatusBadge status={branch.status} />
        </div>
      </Card>

      {performanceQuery.error && (
        <ErrorState message={performanceQuery.error instanceof ApiError ? performanceQuery.error.message : 'Unable to load performance'} onRetry={() => performanceQuery.refetch()} />
      )}

      {perf && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <KpiCard label="Cash position" value={formatGhs(perf.cashPositionPesewas)} />
          <KpiCard label="Income" value={formatGhs(perf.incomePesewas)} />
          <KpiCard label="Expense" value={formatGhs(perf.expensePesewas)} higherIsBetter={false} />
          <KpiCard label="Net income" value={formatGhs(perf.netIncomePesewas)} />
          <KpiCard label="Cost-to-income" value={perf.costToIncomeRatio != null ? `${(perf.costToIncomeRatio * 100).toFixed(1)}%` : '—'} higherIsBetter={false} />
          <KpiCard label="Cash in hand" value={formatGhs(perf.cashInHandPesewas)} />
          <KpiCard label="Vault" value={formatGhs(perf.vaultPesewas)} />
          <KpiCard label="Headcount" value={String(perf.headcount)} />
        </div>
      )}

      {hasPermission('analytics.view') && (
        <>
          <Card title="Disbursements vs. collections">
            <TrendChart data={trendData} />
          </Card>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <KpiCard label="Active loans" value={String(portfolioQuery.data?.loanCount ?? 0)} />
            <KpiCard label="Outstanding principal" value={formatGhs(portfolioQuery.data?.totalOutstandingPesewas)} />
            <KpiCard
              label="Portfolio at risk (30d)"
              value={portfolioQuery.data?.par30.ratio != null ? `${(portfolioQuery.data.par30.ratio * 100).toFixed(1)}%` : '—'}
              higherIsBetter={false}
            />
          </div>

          <Card title="Largest at-risk exposures" padded={false}>
            <DataTable
              columns={[
                { key: 'loan', header: 'Loan', render: (l) => `#${l.loanId}` },
                { key: 'outstanding', header: 'Outstanding', render: (l) => formatGhs(l.outstandingPrincipalPesewas), align: 'right' },
                { key: 'days', header: 'Days overdue', render: (l) => l.daysOverdue, align: 'right' },
              ]}
              rows={portfolioQuery.data?.largestExposures ?? []}
              getRowKey={(l) => l.loanId}
              isLoading={portfolioQuery.isLoading}
              emptyTitle="No at-risk exposures"
            />
          </Card>
        </>
      )}

      <Card title="Staff assigned" padded={false}>
        <DataTable columns={staffColumns} rows={staffQuery.data ?? []} getRowKey={(s) => s.id} isLoading={staffQuery.isLoading} emptyTitle="No staff assigned to this branch" />
      </Card>
    </div>
  );
}
