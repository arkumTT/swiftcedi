import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useAuth } from '../../../auth/AuthContext';
import { isCrossBranchRole } from '../../../lib/roleScope';
import { api, ApiError } from '../../../lib/apiClient';
import { useBranches } from '../../../lib/adminHooks';
import { Card } from '../../../components/Card';
import { DataTable, type Column } from '../../../components/DataTable';
import { FilterToolbar } from '../../../components/FilterToolbar';
import { Button } from '../../../components/Button';
import { Modal } from '../../../components/Modal';
import { selectClasses } from '../../../components/FormField';
import { formatDate, formatGhs } from '../../../lib/format';
import { categoryOf, type JournalEntryRow, type TransactionCategory } from '../dashboard/RecentTransactionsWidget';
import type { JournalEntryDetail } from '../../../types/api';

const SOURCE_MODULES = ['loan', 'savings', 'susu', 'investment', 'cashier', 'manual_jv'];
const LIMIT = 25;

export function TransactionsPage() {
  const { user } = useAuth();
  const crossBranch = isCrossBranchRole(user!.roleName);
  const { data: branches } = useBranches();

  const [branchId, setBranchId] = useState(crossBranch ? '' : user!.homeBranchId);
  const [sourceModule, setSourceModule] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [category, setCategory] = useState<TransactionCategory>('all');
  const [offset, setOffset] = useState(0);
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);

  const entriesQuery = useQuery({
    queryKey: ['transactions', { branchId, sourceModule, fromDate, toDate, offset }],
    queryFn: () =>
      api.get<JournalEntryRow[]>('/gl/journal-entries', {
        branchId: crossBranch ? branchId : user!.homeBranchId,
        sourceModule,
        fromDate,
        toDate,
        limit: LIMIT,
        offset,
      }),
  });

  const filtered = useMemo(() => {
    const rows = entriesQuery.data ?? [];
    if (category === 'all') return rows;
    return rows.filter((r) => categoryOf(r.reference) === category);
  }, [entriesQuery.data, category]);

  const columns: Column<JournalEntryRow>[] = [
    { key: 'date', header: 'Date', render: (r) => formatDate(r.entry_date) },
    { key: 'reference', header: 'Reference', render: (r) => <span className="font-mono text-[12px]">{r.reference}</span> },
    { key: 'description', header: 'Description', render: (r) => r.description ?? '—' },
    { key: 'module', header: 'Module', render: (r) => <span className="capitalize">{r.source_module.replace(/_/g, ' ')}</span> },
    { key: 'amount', header: 'Amount', align: 'right', render: (r) => <span className="tabular-nums">{formatGhs(r.amount_pesewas)}</span> },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-text-primary">Transactions</h1>
        <p className="text-[13px] text-text-secondary">
          The unified GL transaction ledger — every module's financial activity posts through here.
        </p>
      </div>

      <Card padded={false}>
        <FilterToolbar
          chips={[
            { label: 'All', active: category === 'all', onClick: () => setCategory('all') },
            { label: 'Collections', active: category === 'collections', onClick: () => setCategory('collections') },
            { label: 'Payouts', active: category === 'payouts', onClick: () => setCategory('payouts') },
            { label: 'Commissions', active: category === 'commissions', onClick: () => setCategory('commissions') },
          ]}
        >
          {crossBranch && (
            <select
              value={branchId}
              onChange={(e) => {
                setBranchId(e.target.value);
                setOffset(0);
              }}
              className={selectClasses + ' h-8 text-[12.5px]'}
            >
              <option value="">All branches</option>
              {branches?.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          )}
          <select
            value={sourceModule}
            onChange={(e) => {
              setSourceModule(e.target.value);
              setOffset(0);
            }}
            className={selectClasses + ' h-8 text-[12.5px]'}
          >
            <option value="">All modules</option>
            {SOURCE_MODULES.map((m) => (
              <option key={m} value={m}>
                {m.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
          <input
            type="date"
            value={fromDate}
            onChange={(e) => {
              setFromDate(e.target.value);
              setOffset(0);
            }}
            className="h-8 rounded-md border border-border bg-surface px-2.5 text-[12.5px] text-text-primary focus-visible:border-accent"
          />
          <input
            type="date"
            value={toDate}
            onChange={(e) => {
              setToDate(e.target.value);
              setOffset(0);
            }}
            className="h-8 rounded-md border border-border bg-surface px-2.5 text-[12.5px] text-text-primary focus-visible:border-accent"
          />
        </FilterToolbar>
        <DataTable
          columns={columns}
          rows={filtered}
          getRowKey={(r) => r.id}
          isLoading={entriesQuery.isLoading}
          error={entriesQuery.error instanceof ApiError ? entriesQuery.error.message : null}
          onRetry={() => entriesQuery.refetch()}
          onRowClick={(r) => setSelectedEntryId(r.id)}
          emptyTitle="No transactions match these filters"
        />
        <div className="flex items-center justify-between border-t border-border px-3 py-2.5 text-[13px] text-text-secondary">
          <span>
            Showing {offset + 1}–{offset + filtered.length}
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => setOffset(Math.max(0, offset - LIMIT))} disabled={offset === 0} aria-label="Previous page">
              <ChevronLeft size={14} />
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setOffset(offset + LIMIT)}
              disabled={(entriesQuery.data?.length ?? 0) < LIMIT}
              aria-label="Next page"
            >
              <ChevronRight size={14} />
            </Button>
          </div>
        </div>
      </Card>

      <TransactionDetailModal entryId={selectedEntryId} onClose={() => setSelectedEntryId(null)} />
    </div>
  );
}

function TransactionDetailModal({ entryId, onClose }: { entryId: string | null; onClose: () => void }) {
  const detailQuery = useQuery({
    queryKey: ['journal-entry-detail', entryId],
    queryFn: () => api.get<JournalEntryDetail>(`/gl/journal-entries/${entryId}/lines`),
    enabled: entryId !== null,
  });

  const detail = detailQuery.data;
  const totalDebit = detail?.lines.reduce((s, l) => s + Number(l.debit_pesewas), 0) ?? 0;

  return (
    <Modal open={entryId !== null} onClose={onClose} title={detail ? `Transaction ${detail.entry.reference}` : 'Transaction detail'} footer={<Button variant="secondary" size="sm" onClick={onClose}>Close</Button>}>
      {detailQuery.isLoading && <p className="text-[13px] text-text-secondary">Loading…</p>}
      {detailQuery.error && <p className="text-[13px] text-danger">{detailQuery.error instanceof ApiError ? detailQuery.error.message : 'Unable to load transaction detail'}</p>}
      {detail && (
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-text-secondary">
            {formatDate(detail.entry.entry_date)} · {detail.entry.source_module.replace(/_/g, ' ')} · {detail.entry.description ?? 'No description'}
          </p>
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-[11.5px] font-semibold tracking-wide text-text-secondary uppercase">
                <th className="px-2 py-1.5 text-left">Account</th>
                <th className="px-2 py-1.5 text-right">Debit</th>
                <th className="px-2 py-1.5 text-right">Credit</th>
              </tr>
            </thead>
            <tbody>
              {detail.lines.map((l) => (
                <tr key={l.id} className="border-b border-border last:border-b-0">
                  <td className="px-2 py-1.5">
                    {l.account_code} — {l.account_name}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{Number(l.debit_pesewas) > 0 ? formatGhs(l.debit_pesewas) : '—'}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{Number(l.credit_pesewas) > 0 ? formatGhs(l.credit_pesewas) : '—'}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border font-medium">
                <td className="px-2 py-1.5">Total</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{formatGhs(totalDebit)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{formatGhs(totalDebit)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </Modal>
  );
}
