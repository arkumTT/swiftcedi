import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, XCircle, HelpCircle } from 'lucide-react';
import { Card } from '../../components/Card';
import { StatusBadge } from '../../components/StatusBadge';
import { formatDateTime } from '../../lib/format';
import { api } from '../../lib/apiClient';

interface JobRun {
  id: string;
  job_type: string;
  status: string;
  started_at: string;
  error_message: string | null;
}
interface BackupRun {
  id: string;
  status: string;
  started_at: string;
}

/**
 * Deliberately honest about what this codebase can actually observe today
 * (Section 9 recommendation #7) — API reachability and recent job/backup
 * outcomes are real signals from real endpoints. Payment-rail and credit-
 * bureau integration connectivity have no monitoring hooks anywhere in the
 * backend yet (no payments integration is built at all — see
 * Decisions_Log.md), so this screen says so rather than showing a green
 * checkmark for something nobody is actually checking.
 */
export function SystemHealthPage() {
  const healthQuery = useQuery({
    queryKey: ['system-health'],
    queryFn: () => api.get<{ status: string }>('/health'),
    retry: false,
  });
  const failedJobsQuery = useQuery({
    queryKey: ['system-health', 'failed-jobs'],
    queryFn: () => api.get<JobRun[]>('/system-admin/job-run-history', { status: 'failed' }),
  });
  const backupsQuery = useQuery({
    queryKey: ['system-health', 'backups'],
    queryFn: () => api.get<BackupRun[]>('/system-admin/backups'),
  });

  const lastBackup = backupsQuery.data?.[0];

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card>
          <div className="flex items-center gap-3">
            {healthQuery.isSuccess ? (
              <CheckCircle2 className="text-success" size={28} />
            ) : (
              <XCircle className="text-danger" size={28} />
            )}
            <div>
              <p className="text-[13px] font-medium text-text-primary">API reachability</p>
              <p className="text-[12.5px] text-text-secondary">{healthQuery.isSuccess ? 'Responding normally' : 'Unreachable'}</p>
            </div>
          </div>
        </Card>
        <Card>
          <div className="flex items-center gap-3">
            {lastBackup?.status === 'success' ? (
              <CheckCircle2 className="text-success" size={28} />
            ) : (
              <XCircle className="text-danger" size={28} />
            )}
            <div>
              <p className="text-[13px] font-medium text-text-primary">Last backup</p>
              <p className="text-[12.5px] text-text-secondary">{lastBackup ? formatDateTime(lastBackup.started_at) : 'Never run'}</p>
            </div>
          </div>
        </Card>
        <Card>
          <div className="flex items-center gap-3">
            <HelpCircle className="text-text-muted" size={28} />
            <div>
              <p className="text-[13px] font-medium text-text-primary">Payments / credit bureau integration</p>
              <p className="text-[12.5px] text-text-secondary">Not monitored — no integration is wired up yet</p>
            </div>
          </div>
        </Card>
      </div>

      <Card title="Recent job failures">
        {(failedJobsQuery.data ?? []).length === 0 ? (
          <p className="text-[13px] text-text-secondary">No failed job runs recorded.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {failedJobsQuery.data!.slice(0, 10).map((j) => (
              <li key={j.id} className="flex items-center justify-between py-2 text-[13px]">
                <div>
                  <p className="font-medium text-text-primary">{j.job_type}</p>
                  <p className="text-text-secondary">{j.error_message}</p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusBadge status="failed" />
                  <span className="text-[12px] text-text-muted">{formatDateTime(j.started_at)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
