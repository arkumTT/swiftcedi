import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card } from '../../../components/Card';
import { DataTable, type Column } from '../../../components/DataTable';
import { FilterToolbar } from '../../../components/FilterToolbar';
import { formatDate, formatGhs } from '../../../lib/format';
import { api, ApiError } from '../../../lib/apiClient';

interface JournalEntryRow {
  id: string;
  reference: string;
  description: string | null;
  entry_date: string;
  source_module: string;
  amount_pesewas: string;
}

type Category = 'all' | 'collections' | 'payouts' | 'commissions';

// Every module's own posting code already suffixes its reference this way
// (see Decisions_Log.md's glService.listJournalEntries entry) — grouping
// off that existing convention rather than adding a new backend column.
const COLLECTION_SUFFIXES = ['-RPY', '-DEP', '-COL'];
const PAYOUT_SUFFIXES = ['-DISB', '-WDL', '-PYT', '-WOFF', '-RDM'];
const COMMISSION_SUFFIXES = ['-COMM'];

function categoryOf(reference: string): Exclude<Category, 'all'> | 'other' {
  if (COLLECTION_SUFFIXES.some((s) => reference.includes(s))) return 'collections';
  if (PAYOUT_SUFFIXES.some((s) => reference.includes(s))) return 'payouts';
  if (COMMISSION_SUFFIXES.some((s) => reference.includes(s))) return 'commissions';
  return 'other';
}

export function RecentTransactionsWidget({ branchId }: { branchId?: string }) {
  const [category, setCategory] = useState<Category>('all');

  const query = useQuery({
    queryKey: ['recent-transactions', branchId],
    queryFn: () => api.get<JournalEntryRow[]>('/gl/journal-entries', { branchId, limit: 30 }),
  });

  const filtered = useMemo(() => {
    const rows = query.data ?? [];
    if (category === 'all') return rows;
    return rows.filter((r) => categoryOf(r.reference) === category);
  }, [query.data, category]);

  const columns: Column<JournalEntryRow>[] = [
    { key: 'date', header: 'Date', render: (r) => formatDate(r.entry_date) },
    { key: 'reference', header: 'Reference', render: (r) => <span className="font-mono text-[12px]">{r.reference}</span> },
    { key: 'module', header: 'Module', render: (r) => <span className="capitalize">{r.source_module.replace(/_/g, ' ')}</span> },
    { key: 'amount', header: 'Amount', align: 'right', render: (r) => <span className="tabular-nums">{formatGhs(r.amount_pesewas)}</span> },
  ];

  return (
    <Card title="Recent transactions" padded={false}>
      <FilterToolbar
        chips={[
          { label: 'All', active: category === 'all', onClick: () => setCategory('all') },
          { label: 'Collections', active: category === 'collections', onClick: () => setCategory('collections') },
          { label: 'Payouts', active: category === 'payouts', onClick: () => setCategory('payouts') },
          { label: 'Commissions', active: category === 'commissions', onClick: () => setCategory('commissions') },
        ]}
      />
      <DataTable
        columns={columns}
        rows={filtered}
        getRowKey={(r) => r.id}
        isLoading={query.isLoading}
        error={query.error instanceof ApiError ? query.error.message : null}
        onRetry={() => query.refetch()}
        emptyTitle="No transactions yet"
      />
    </Card>
  );
}
