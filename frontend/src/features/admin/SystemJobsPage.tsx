import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Play } from 'lucide-react';
import { Card } from '../../components/Card';
import { DataTable, type Column } from '../../components/DataTable';
import { StatusBadge } from '../../components/StatusBadge';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { FormField, inputClasses, selectClasses } from '../../components/FormField';
import { formatDateTime } from '../../lib/format';
import { api, ApiError } from '../../lib/apiClient';
import { useAuth } from '../../auth/AuthContext';

const JOB_TYPES = [
  'loan_overdraft_interest_accrual',
  'investment_interest_accrual',
  'cashier_day_close',
  'standing_order_execution',
  'agent_location_purge',
  'archive_sweep',
  'subscription_expiry_check',
  'repayment_due_reminders',
  'susu_collection_due_reminders',
];

interface ScheduledJob {
  id: string;
  job_type: string;
  cron_expression: string;
  status: 'active' | 'paused';
  last_run_at: string | null;
  last_status: 'success' | 'failed' | null;
}
interface JobRun {
  id: string;
  job_type: string;
  status: 'running' | 'success' | 'failed';
  started_at: string;
  completed_at: string | null;
  error_message: string | null;
}

export function SystemJobsPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);

  const jobsQuery = useQuery({ queryKey: ['scheduled-jobs'], queryFn: () => api.get<ScheduledJob[]>('/system-admin/jobs') });
  const historyQuery = useQuery({ queryKey: ['job-run-history'], queryFn: () => api.get<JobRun[]>('/system-admin/job-run-history') });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api.patch(`/system-admin/jobs/${id}/status`, { status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['scheduled-jobs'] }),
  });
  const triggerMutation = useMutation({
    mutationFn: (jobId: string) => api.post('/system-admin/jobs/trigger', { jobId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scheduled-jobs'] });
      queryClient.invalidateQueries({ queryKey: ['job-run-history'] });
    },
  });

  const jobColumns: Column<ScheduledJob>[] = [
    { key: 'type', header: 'Job', render: (j) => <span className="font-mono text-[12.5px]">{j.job_type}</span> },
    { key: 'cron', header: 'Schedule', render: (j) => <span className="font-mono text-[12px] text-text-secondary">{j.cron_expression}</span> },
    { key: 'status', header: 'Status', render: (j) => <StatusBadge status={j.status} /> },
    { key: 'lastRun', header: 'Last run', render: (j) => formatDateTime(j.last_run_at) },
    { key: 'lastStatus', header: 'Last result', render: (j) => (j.last_status ? <StatusBadge status={j.last_status} /> : '—') },
  ];

  const historyColumns: Column<JobRun>[] = [
    { key: 'type', header: 'Job', render: (r) => <span className="font-mono text-[12.5px]">{r.job_type}</span> },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'started', header: 'Started', render: (r) => formatDateTime(r.started_at) },
    { key: 'error', header: 'Error', render: (r) => r.error_message ?? '—' },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Scheduled jobs"
        actions={
          <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
            <Plus size={14} /> Schedule a job
          </Button>
        }
        padded={false}
      >
        <p className="border-b border-border px-4 py-2.5 text-[12.5px] text-text-secondary">
          No live cron daemon runs these automatically yet — every run today is triggered manually here or via the API. See Decisions_Log.md.
        </p>
        <DataTable
          columns={jobColumns}
          rows={jobsQuery.data ?? []}
          getRowKey={(j) => j.id}
          isLoading={jobsQuery.isLoading}
          error={jobsQuery.error instanceof ApiError ? jobsQuery.error.message : null}
          onRetry={() => jobsQuery.refetch()}
          emptyTitle="No jobs scheduled yet"
          rowActions={(j) => (
            <div className="flex justify-end gap-1.5">
              <Button variant="secondary" size="sm" onClick={() => triggerMutation.mutate(j.id)} disabled={triggerMutation.isPending}>
                <Play size={13} /> Run now
              </Button>
              <Button variant="secondary" size="sm" onClick={() => statusMutation.mutate({ id: j.id, status: j.status === 'active' ? 'paused' : 'active' })}>
                {j.status === 'active' ? 'Pause' : 'Resume'}
              </Button>
            </div>
          )}
        />
      </Card>

      <Card title="Job run history" padded={false}>
        <DataTable
          columns={historyColumns}
          rows={historyQuery.data ?? []}
          getRowKey={(r) => r.id}
          isLoading={historyQuery.isLoading}
          error={historyQuery.error instanceof ApiError ? historyQuery.error.message : null}
          onRetry={() => historyQuery.refetch()}
          emptyTitle="No job runs recorded yet"
        />
      </Card>

      <CreateJobModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => queryClient.invalidateQueries({ queryKey: ['scheduled-jobs'] })}
      />
    </div>
  );
}

function CreateJobModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const { user } = useAuth();
  const [jobType, setJobType] = useState(JOB_TYPES[0]);
  const [cronExpression, setCronExpression] = useState('0 1 * * *');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    // run_as_user_id is bookkeeping for a future real scheduler (see
    // Decisions_Log.md) — triggerJob always acts as whoever clicks "Run
    // now," not this stored value, but the column is NOT NULL today.
    mutationFn: () => api.post('/system-admin/jobs', { jobType, cronExpression, runAsUserId: user!.id }),
    onSuccess: () => {
      onCreated();
      onClose();
      setError(null);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to schedule job'),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Schedule a job"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
            Schedule
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label="Job type">
          {(id) => (
            <select id={id} value={jobType} onChange={(e) => setJobType(e.target.value)} className={selectClasses}>
              {JOB_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          )}
        </FormField>
        <FormField label="Cron expression" hint="Bookkeeping only until a real scheduler daemon is wired up — see Decisions_Log.md.">
          {(id) => <input id={id} value={cronExpression} onChange={(e) => setCronExpression(e.target.value)} className={inputClasses + ' font-mono'} />}
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
