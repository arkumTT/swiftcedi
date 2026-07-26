import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card } from '../../components/Card';
import { DataTable, type Column } from '../../components/DataTable';
import { FilterToolbar } from '../../components/FilterToolbar';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/Button';
import { inputClasses } from '../../components/FormField';
import { formatDateTime } from '../../lib/format';
import { api, ApiError } from '../../lib/apiClient';

interface AuditLogRow {
  id: string;
  user_id: string | null;
  branch_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  before_state: unknown;
  after_state: unknown;
  created_at: string;
}

const PAGE_SIZE = 50;

export function AuditLogPage() {
  const [entityType, setEntityType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<AuditLogRow | null>(null);

  const query = useQuery({
    queryKey: ['audit-log', { entityType, from, to, offset }],
    queryFn: () => api.get<AuditLogRow[]>('/audit-log', { entityType, from, to, limit: PAGE_SIZE, offset }),
  });

  const columns: Column<AuditLogRow>[] = [
    { key: 'when', header: 'When', render: (r) => formatDateTime(r.created_at) },
    { key: 'action', header: 'Action', render: (r) => <span className="font-mono text-[12.5px]">{r.action}</span> },
    { key: 'entity', header: 'Entity', render: (r) => `${r.entity_type} #${r.entity_id}` },
    { key: 'user', header: 'Actor user id', render: (r) => r.user_id ?? 'System' },
    { key: 'branch', header: 'Branch id', render: (r) => r.branch_id },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Card title="Audit log" padded={false}>
        <FilterToolbar>
          <input value={entityType} onChange={(e) => setEntityType(e.target.value)} placeholder="Entity type…" className={inputClasses + ' h-8 w-36 text-[12.5px]'} />
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputClasses + ' h-8 text-[12.5px]'} />
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={inputClasses + ' h-8 text-[12.5px]'} />
        </FilterToolbar>
        <DataTable
          columns={columns}
          rows={query.data ?? []}
          getRowKey={(r) => r.id}
          isLoading={query.isLoading}
          error={query.error instanceof ApiError ? query.error.message : null}
          onRetry={() => query.refetch()}
          emptyTitle="No matching audit entries"
          onRowClick={(r) => setSelected(r)}
        />
        <div className="flex items-center justify-between border-t border-border px-3 py-2.5">
          <Button variant="secondary" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
            Previous
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={(query.data?.length ?? 0) < PAGE_SIZE}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            Next
          </Button>
        </div>
      </Card>

      <Modal open={Boolean(selected)} onClose={() => setSelected(null)} title={selected ? `${selected.action}` : ''}>
        {selected && (
          <div className="grid grid-cols-2 gap-3 text-[12px]">
            <div>
              <p className="mb-1 font-semibold text-text-secondary uppercase">Before</p>
              <pre className="max-h-64 overflow-auto rounded-md bg-surface-alt p-2 whitespace-pre-wrap">{JSON.stringify(selected.before_state, null, 2) ?? '—'}</pre>
            </div>
            <div>
              <p className="mb-1 font-semibold text-text-secondary uppercase">After</p>
              <pre className="max-h-64 overflow-auto rounded-md bg-surface-alt p-2 whitespace-pre-wrap">{JSON.stringify(selected.after_state, null, 2) ?? '—'}</pre>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
