import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid, LabelList } from 'recharts';
import { api, ApiError } from '../../../lib/apiClient';
import { Card } from '../../../components/Card';
import { DataTable, type Column } from '../../../components/DataTable';
import { FilterToolbar } from '../../../components/FilterToolbar';
import { StatusBadge } from '../../../components/StatusBadge';
import { selectClasses } from '../../../components/FormField';
import { formatGhs } from '../../../lib/format';
import type { Branch, Region, Cluster, BranchPerformance } from '../../../types/api';

export function BranchesPage() {
  const navigate = useNavigate();

  const [regionId, setRegionId] = useState('');
  const [clusterId, setClusterId] = useState('');
  const [status, setStatus] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const regionsQuery = useQuery({ queryKey: ['branch-regions'], queryFn: () => api.get<Region[]>('/branches/regions') });
  const clustersQuery = useQuery({ queryKey: ['branch-clusters', regionId], queryFn: () => api.get<Cluster[]>('/branches/clusters', { regionId }) });
  const branchesQuery = useQuery({
    queryKey: ['branches-list', { regionId, clusterId, status }],
    queryFn: () => api.get<Branch[]>('/branches', { regionId, clusterId, status }),
  });

  const performanceQueries = useQueries({
    queries: selectedIds.map((id) => ({
      queryKey: ['branch-performance-compare', id],
      queryFn: () => api.get<BranchPerformance>(`/branches/${id}/performance`),
    })),
  });

  const compareData = useMemo(
    () =>
      selectedIds.map((id, i) => ({
        branchId: id,
        branchName: branchesQuery.data?.find((b) => b.id === id)?.name ?? `#${id}`,
        netIncomePesewas: performanceQueries[i]?.data?.netIncomePesewas ?? 0,
      })),
    [selectedIds, branchesQuery.data, performanceQueries]
  );

  function toggleSelected(id: string) {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : prev.length < 6 ? [...prev, id] : prev));
  }

  const columns: Column<Branch>[] = [
    {
      key: 'select',
      header: '',
      render: (b) => (
        <input
          type="checkbox"
          checked={selectedIds.includes(b.id)}
          onChange={() => toggleSelected(b.id)}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Compare ${b.name}`}
        />
      ),
    },
    { key: 'code', header: 'Code', render: (b) => b.code },
    { key: 'name', header: 'Branch', render: (b) => b.name },
    { key: 'status', header: 'Status', render: (b) => <StatusBadge status={b.status} /> },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-text-primary">Branches</h1>
        <p className="text-[13px] text-text-secondary">Cash position, profitability, and portfolio quality by branch.</p>
      </div>

      <Card title="Branches" padded={false}>
        <FilterToolbar>
          <select
            value={regionId}
            onChange={(e) => {
              setRegionId(e.target.value);
              setClusterId('');
            }}
            className={selectClasses + ' h-8 text-[12.5px]'}
          >
            <option value="">All regions</option>
            {regionsQuery.data?.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <select value={clusterId} onChange={(e) => setClusterId(e.target.value)} className={selectClasses + ' h-8 text-[12.5px]'}>
            <option value="">All clusters</option>
            {clustersQuery.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={selectClasses + ' h-8 text-[12.5px]'}>
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
            <option value="under_review">Under review</option>
            <option value="closed">Closed</option>
          </select>
        </FilterToolbar>
        <DataTable
          columns={columns}
          rows={branchesQuery.data ?? []}
          getRowKey={(b) => b.id}
          isLoading={branchesQuery.isLoading}
          error={branchesQuery.error instanceof ApiError ? branchesQuery.error.message : null}
          onRetry={() => branchesQuery.refetch()}
          onRowClick={(b) => navigate(`/app/branches/${b.id}`)}
          emptyTitle="No branches match these filters"
        />
      </Card>

      {selectedIds.length > 0 && (
        <Card title={`Compare net income (${selectedIds.length} selected)`}>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={compareData} margin={{ top: 20, right: 12, left: 4, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
              <XAxis dataKey="branchName" tick={{ fontSize: 11, fill: 'var(--color-text-secondary)' }} axisLine={{ stroke: 'var(--color-border)' }} tickLine={false} />
              <YAxis tickFormatter={(v) => formatGhs(v)} tick={{ fontSize: 11, fill: 'var(--color-text-secondary)' }} axisLine={false} tickLine={false} width={70} />
              <Tooltip formatter={(value) => formatGhs(Number(value))} contentStyle={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 8, fontSize: 12 }} />
              <Bar dataKey="netIncomePesewas" radius={[4, 4, 4, 4]} maxBarSize={48}>
                <LabelList dataKey="netIncomePesewas" position="top" formatter={(v: unknown) => formatGhs(Number(v))} style={{ fontSize: 11, fill: 'var(--color-text-secondary)' }} />
                {compareData.map((d, i) => (
                  <Cell key={i} fill={d.netIncomePesewas >= 0 ? 'var(--color-success)' : 'var(--color-danger)'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>
      )}
    </div>
  );
}
