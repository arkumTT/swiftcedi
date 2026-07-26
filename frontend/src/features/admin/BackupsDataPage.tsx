import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Play, DatabaseBackup } from 'lucide-react';
import { Card } from '../../components/Card';
import { DataTable, type Column } from '../../components/DataTable';
import { StatusBadge } from '../../components/StatusBadge';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { FormField, inputClasses, selectClasses } from '../../components/FormField';
import { formatDateTime } from '../../lib/format';
import { api, ApiError } from '../../lib/apiClient';

const EXPORTABLE_TABLES = ['branches', 'customers', 'loans', 'savings_accounts', 'investments', 'gl_accounts'];
const ARCHIVE_ENTITY_TYPES = ['closed_loans', 'closed_savings_accounts'];

interface BackupRun {
  id: string;
  status: 'running' | 'success' | 'failed';
  started_at: string;
  file_path: string | null;
  file_size_bytes: string | null;
  error_message: string | null;
}
interface ArchivePolicy {
  id: string;
  entity_type: string;
  retention_period_days: number;
  archive_location: string;
  status: 'active' | 'inactive';
}

export function BackupsDataPage() {
  const queryClient = useQueryClient();
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [policyOpen, setPolicyOpen] = useState(false);

  const backupsQuery = useQuery({ queryKey: ['backup-runs'], queryFn: () => api.get<BackupRun[]>('/system-admin/backups') });
  const policiesQuery = useQuery({ queryKey: ['archive-policies'], queryFn: () => api.get<ArchivePolicy[]>('/system-admin/archive-policies') });

  const backupMutation = useMutation({
    mutationFn: () => api.post('/system-admin/backups'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['backup-runs'] }),
  });
  const runPolicyMutation = useMutation({
    mutationFn: (id: string) => api.post(`/system-admin/archive-policies/${id}/run`),
  });

  async function downloadCsv(table: string) {
    const csv = await api.getRaw(`/system-admin/export/${table}`);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${table}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const backupColumns: Column<BackupRun>[] = [
    { key: 'started', header: 'Started', render: (b) => formatDateTime(b.started_at) },
    { key: 'status', header: 'Status', render: (b) => <StatusBadge status={b.status} /> },
    { key: 'size', header: 'Size', align: 'right', render: (b) => (b.file_size_bytes ? `${(Number(b.file_size_bytes) / 1024).toFixed(0)} KB` : '—') },
    { key: 'error', header: 'Error', render: (b) => b.error_message ?? '—' },
  ];

  const policyColumns: Column<ArchivePolicy>[] = [
    { key: 'entity', header: 'Entity type', render: (p) => p.entity_type.replace(/_/g, ' ') },
    { key: 'retention', header: 'Retention (days)', align: 'right', render: (p) => p.retention_period_days },
    { key: 'location', header: 'Archive location', render: (p) => <span className="font-mono text-[12px]">{p.archive_location}</span> },
    { key: 'status', header: 'Status', render: (p) => <StatusBadge status={p.status} /> },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Database backups"
        actions={
          <Button variant="primary" size="sm" onClick={() => backupMutation.mutate()} disabled={backupMutation.isPending}>
            <DatabaseBackup size={14} /> Run backup now
          </Button>
        }
        padded={false}
      >
        <DataTable
          columns={backupColumns}
          rows={backupsQuery.data ?? []}
          getRowKey={(b) => b.id}
          isLoading={backupsQuery.isLoading}
          error={backupsQuery.error instanceof ApiError ? backupsQuery.error.message : null}
          onRetry={() => backupsQuery.refetch()}
          emptyTitle="No backups run yet"
        />
        <div className="flex justify-end border-t border-border px-4 py-2.5">
          <Button variant="secondary" size="sm" onClick={() => setRestoreOpen(true)}>
            Restore from backup…
          </Button>
        </div>
      </Card>

      <Card title="Backup-to-Excel export" padded={false}>
        <div className="flex flex-wrap gap-2 p-4">
          {EXPORTABLE_TABLES.map((t) => (
            <Button key={t} variant="secondary" size="sm" onClick={() => downloadCsv(t)}>
              <Download size={13} /> {t.replace(/_/g, ' ')}.csv
            </Button>
          ))}
        </div>
      </Card>

      <Card
        title="Archive policies"
        actions={
          <Button variant="primary" size="sm" onClick={() => setPolicyOpen(true)}>
            New policy
          </Button>
        }
        padded={false}
      >
        <DataTable
          columns={policyColumns}
          rows={policiesQuery.data ?? []}
          getRowKey={(p) => p.id}
          isLoading={policiesQuery.isLoading}
          error={policiesQuery.error instanceof ApiError ? policiesQuery.error.message : null}
          onRetry={() => policiesQuery.refetch()}
          emptyTitle="No archive policies configured"
          emptyDescription="A record is only ever soft-flagged archived (never moved or deleted), and only once it's reached a terminal status and cleared the retention window."
          rowActions={(p) => (
            <Button variant="secondary" size="sm" onClick={() => runPolicyMutation.mutate(p.id)} disabled={runPolicyMutation.isPending}>
              <Play size={13} /> Run sweep
            </Button>
          )}
        />
      </Card>

      <RestoreModal open={restoreOpen} onClose={() => setRestoreOpen(false)} />
      <PolicyModal open={policyOpen} onClose={() => setPolicyOpen(false)} onCreated={() => queryClient.invalidateQueries({ queryKey: ['archive-policies'] })} />
    </div>
  );
}

function RestoreModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [filePath, setFilePath] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.post('/system-admin/backups/restore', { filePath, confirm: true }),
    onSuccess: () => setResult('Restore completed.'),
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Restore failed'),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Restore from backup"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Close
          </Button>
          <Button variant="danger" size="sm" disabled={!confirmed || !filePath || mutation.isPending} onClick={() => mutation.mutate()}>
            Restore (overwrites live data)
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="rounded-md border border-danger/25 bg-danger/10 p-2.5 text-[12.5px] text-danger">
          This is a destructive, irreversible operation — it overwrites the current database with the chosen backup file.
        </p>
        <FormField label="Backup file name" hint="Relative to the server's backup directory — copy it from a row above.">
          {(id) => <input id={id} value={filePath} onChange={(e) => setFilePath(e.target.value)} className={inputClasses} />}
        </FormField>
        <label className="flex items-center gap-2 text-[13px] text-text-primary">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          I understand this will overwrite live data.
        </label>
        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
        {result && <p className="text-[13px] text-success">{result}</p>}
      </div>
    </Modal>
  );
}

function PolicyModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [entityType, setEntityType] = useState(ARCHIVE_ENTITY_TYPES[0]);
  const [retentionDays, setRetentionDays] = useState('365');
  const [location, setLocation] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      api.post('/system-admin/archive-policies', {
        entityType,
        retentionPeriodDays: Number(retentionDays),
        archiveLocation: location,
      }),
    onSuccess: () => {
      onCreated();
      onClose();
      setError(null);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to create policy'),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New archive policy"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
            Create
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label="Entity type">
          {(id) => (
            <select id={id} value={entityType} onChange={(e) => setEntityType(e.target.value)} className={selectClasses}>
              {ARCHIVE_ENTITY_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          )}
        </FormField>
        <FormField label="Retention period (days)">
          {(id) => <input id={id} type="number" min="1" value={retentionDays} onChange={(e) => setRetentionDays(e.target.value)} className={inputClasses} />}
        </FormField>
        <FormField label="Archive location" hint="A reference string (e.g. a storage path) — no data is physically moved.">
          {(id) => <input id={id} value={location} onChange={(e) => setLocation(e.target.value)} className={inputClasses} />}
        </FormField>
        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
