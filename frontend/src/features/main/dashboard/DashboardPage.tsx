import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Landmark, HandCoins, Wallet, ShieldAlert, Users, PiggyBank, Receipt, MapPinned } from 'lucide-react';
import { useAuth } from '../../../auth/AuthContext';
import { isCrossBranchRole } from '../../../lib/roleScope';
import { api } from '../../../lib/apiClient';
import { Card } from '../../../components/Card';
import { KpiCard } from '../../../components/KpiCard';
import { Button } from '../../../components/Button';
import { TrendChart, type TrendPoint } from './TrendChart';
import { BranchParChart, type BranchParPoint } from './BranchParChart';
import { RecentTransactionsWidget } from './RecentTransactionsWidget';
import { formatGhs } from '../../../lib/format';
import type { Branch } from '../../../types/api';

interface LiveStats {
  cashPosition: { totalPesewas?: number; branches?: { branchId: number; totalPesewas: number }[] } & Record<string, unknown>;
  todaysDisbursements: { count: number; totalPesewas: number };
  todaysCollections: {
    loanRepayments: { count: number; totalPesewas: number };
    savingsDeposits: { count: number; totalPesewas: number };
    susuCollections: { count: number; totalPesewas: number };
  };
}
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

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
function monthsAgoIso(n: number) {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 10);
}

export function DashboardPage() {
  const { user, hasPermission } = useAuth();
  const navigate = useNavigate();
  const crossBranch = isCrossBranchRole(user!.roleName);
  const canViewTransactions = hasPermission('gl.view_reports');
  // cashier and field_agent roles are deliberately not analytics audiences
  // (see migration 045's role_permissions seed) — their dashboard queries
  // must be gated the same way, or they'd fire 403s against
  // /analytics/live-stats etc. and show misleading all-zero KPI tiles.
  const canViewAnalytics = hasPermission('analytics.view');
  // 'all' is a real, backend-recognized sentinel (resolveAnalyticsBranchScope,
  // see Decisions_Log.md) — without it, omitting branchId defaults to the
  // caller's OWN home branch even for owner/system_admin, which would
  // silently scope "consolidated" dashboards to just one branch.
  const analyticsScopeBranchId = crossBranch ? 'all' : user!.homeBranchId;
  const ledgerScopeBranchId = crossBranch ? undefined : user!.homeBranchId;

  const liveStats = useQuery({
    queryKey: ['live-stats', analyticsScopeBranchId],
    queryFn: () => api.get<LiveStats>('/analytics/live-stats', { branchId: analyticsScopeBranchId }),
    enabled: canViewAnalytics,
  });
  const portfolioQuality = useQuery({
    queryKey: ['portfolio-quality', analyticsScopeBranchId, user!.roleName === 'loan_officer' ? user!.id : undefined],
    queryFn: () =>
      api.get<PortfolioQuality>('/analytics/portfolio-quality', {
        branchId: analyticsScopeBranchId,
        loanOfficerId: user!.roleName === 'loan_officer' ? user!.id : undefined,
      }),
    enabled: canViewAnalytics,
  });
  const growthTrends = useQuery({
    queryKey: ['growth-trends', analyticsScopeBranchId],
    queryFn: () =>
      api.get<GrowthTrends>('/analytics/growth-trends', {
        fromDate: monthsAgoIso(6),
        toDate: todayIso(),
        branchId: analyticsScopeBranchId,
        granularity: 'month',
      }),
    enabled: canViewAnalytics,
  });
  const branchesQuery = useQuery({
    queryKey: ['branches'],
    queryFn: () => api.get<Branch[]>('/branches'),
    enabled: crossBranch && canViewAnalytics,
  });
  const branchParQueries = useQueries({
    queries: (crossBranch ? branchesQuery.data ?? [] : []).map((b) => ({
      queryKey: ['portfolio-quality', b.id],
      queryFn: () => api.get<PortfolioQuality>('/analytics/portfolio-quality', { branchId: b.id }),
    })),
  });

  const trendData: TrendPoint[] = useMemo(() => {
    if (!growthTrends.data) return [];
    const byPeriod = new Map<string, TrendPoint>();
    for (const d of growthTrends.data.disbursementTrend) {
      byPeriod.set(d.period, { period: d.period.slice(0, 7), disbursedPesewas: d.totalPesewas, collectedPesewas: 0 });
    }
    for (const d of growthTrends.data.depositGrowth) {
      const key = d.period;
      const existing = byPeriod.get(key);
      if (existing) existing.collectedPesewas = d.netPesewas;
      else byPeriod.set(key, { period: key.slice(0, 7), disbursedPesewas: 0, collectedPesewas: d.netPesewas });
    }
    return [...byPeriod.values()].sort((a, b) => a.period.localeCompare(b.period));
  }, [growthTrends.data]);

  const branchParData: BranchParPoint[] = useMemo(() => {
    if (!crossBranch || !branchesQuery.data) return [];
    return branchesQuery.data.map((b, i) => ({
      branchName: b.name,
      par30Ratio: branchParQueries[i]?.data?.par30.ratio ?? 0,
    }));
  }, [crossBranch, branchesQuery.data, branchParQueries]);

  const totalCollectedToday =
    (liveStats.data?.todaysCollections.loanRepayments.totalPesewas ?? 0) +
    (liveStats.data?.todaysCollections.savingsDeposits.totalPesewas ?? 0) +
    (liveStats.data?.todaysCollections.susuCollections.totalPesewas ?? 0);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-text-primary">
          {crossBranch ? 'Consolidated dashboard' : user!.roleName === 'loan_officer' ? 'My loan book' : 'Branch dashboard'}
        </h1>
        <p className="text-[13px] text-text-secondary">Welcome back, {user!.fullName}.</p>
      </div>

      {canViewAnalytics && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard label="Today's disbursements" value={formatGhs(liveStats.data?.todaysDisbursements.totalPesewas)} icon={<Landmark size={16} />} />
          <KpiCard label="Today's collections" value={formatGhs(totalCollectedToday)} icon={<HandCoins size={16} />} />
          <KpiCard
            label="Cash position"
            value={formatGhs(typeof liveStats.data?.cashPosition.totalPesewas === 'number' ? liveStats.data.cashPosition.totalPesewas : 0)}
            icon={<Wallet size={16} />}
          />
          <KpiCard
            label="Portfolio at risk (30d)"
            value={portfolioQuality.data?.par30.ratio != null ? `${(portfolioQuality.data.par30.ratio * 100).toFixed(1)}%` : '—'}
            higherIsBetter={false}
            icon={<ShieldAlert size={16} />}
          />
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {canViewAnalytics && (
          <Card title="Disbursements vs. collections">
            <TrendChart data={trendData} />
          </Card>
        )}
        {crossBranch && canViewAnalytics ? (
          <Card title="Branch PAR30 comparison">
            <BranchParChart data={branchParData} />
          </Card>
        ) : (
          <Card title="Quick actions">
            <div className="flex flex-wrap gap-2">
              {hasPermission('customer.create') && (
                <Button variant="secondary" size="sm" onClick={() => navigate('/app/customers')}>
                  <Users size={14} /> Customers & CRM
                </Button>
              )}
              {hasPermission('loan.apply') && (
                <Button variant="secondary" size="sm" onClick={() => navigate('/app/loans')}>
                  <Landmark size={14} /> Loans & Credit
                </Button>
              )}
              {(hasPermission('savings.view') || hasPermission('susu.view') || hasPermission('susu.record_collection')) && (
                <Button variant="secondary" size="sm" onClick={() => navigate('/app/savings')}>
                  <PiggyBank size={14} /> Savings & Susu
                </Button>
              )}
              {hasPermission('cashier.view') && (
                <Button variant="secondary" size="sm" onClick={() => navigate('/app/cashier')}>
                  <Wallet size={14} /> Cashier & Vault
                </Button>
              )}
              {canViewTransactions && (
                <Button variant="secondary" size="sm" onClick={() => navigate('/app/transactions')}>
                  <Receipt size={14} /> Transactions
                </Button>
              )}
              {(hasPermission('agent.manage') || hasPermission('agent.view_locations') || hasPermission('agent.ping_location')) && (
                <Button variant="secondary" size="sm" onClick={() => navigate('/app/agents')}>
                  <MapPinned size={14} /> Field Agents
                </Button>
              )}
            </div>
          </Card>
        )}
      </div>

      {canViewTransactions && <RecentTransactionsWidget branchId={ledgerScopeBranchId} />}
    </div>
  );
}
