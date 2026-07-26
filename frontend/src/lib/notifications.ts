import { useQuery } from '@tanstack/react-query';
import { api } from './apiClient';
import { useAuth } from '../auth/AuthContext';

export interface NotificationItem {
  id: string;
  kind: 'reminder' | 'job_failure' | 'aml_flag' | 'approval';
  title: string;
  detail: string;
  at: string;
  tone: 'warning' | 'danger' | 'info';
}

interface ReminderRow {
  id: string;
  notification_type: string;
  message: string;
  due_date: string;
}
interface JobRunRow {
  id: string;
  job_type: string;
  error_message: string | null;
  started_at: string;
}
interface AmlFlagRow {
  id: string;
  rule_id: string;
  flagged_at: string;
  transaction_type: string;
}
interface ApprovalRow {
  id: string;
  action_type: string;
  amount_pesewas: string | null;
  created_at: string;
}

/**
 * Aggregates real data from four already-existing list endpoints into one
 * feed (Section 9's "Notification center" recommendation) — no new backend
 * endpoint, since each source already has a filterable list route. Gated
 * per-source by the permission that already protects that source's screen,
 * so a role without e.g. compliance.manage_aml simply doesn't request (or
 * see) AML flags here.
 */
export function useNotifications() {
  const { hasAnyPermission } = useAuth();

  const canSeeReminders = hasAnyPermission(['sysadmin.manage_jobs']);
  const canSeeJobs = hasAnyPermission(['sysadmin.manage_jobs']);
  const canSeeAml = hasAnyPermission(['compliance.manage_aml']);
  const canSeeApprovals = hasAnyPermission(['approval.decide']);

  const reminders = useQuery({
    queryKey: ['notifications', 'reminders'],
    queryFn: () => api.get<ReminderRow[]>('/system-admin/reminders', { status: 'pending' }),
    enabled: canSeeReminders,
    refetchInterval: 60_000,
  });
  const jobFailures = useQuery({
    queryKey: ['notifications', 'job-failures'],
    queryFn: () => api.get<JobRunRow[]>('/system-admin/job-run-history', { status: 'failed' }),
    enabled: canSeeJobs,
    refetchInterval: 60_000,
  });
  const amlFlags = useQuery({
    queryKey: ['notifications', 'aml-flags'],
    queryFn: () => api.get<AmlFlagRow[]>('/compliance/aml/flags', { status: 'open' }),
    enabled: canSeeAml,
    refetchInterval: 60_000,
  });
  const approvals = useQuery({
    queryKey: ['notifications', 'approvals'],
    queryFn: () => api.get<ApprovalRow[]>('/approvals', { status: 'pending' }),
    enabled: canSeeApprovals,
    refetchInterval: 60_000,
  });

  const items: NotificationItem[] = [
    ...(reminders.data ?? []).slice(0, 20).map((r) => ({
      id: `reminder-${r.id}`,
      kind: 'reminder' as const,
      title: r.notification_type === 'repayment_due' ? 'Repayment due' : 'Susu collection due',
      detail: r.message,
      at: r.due_date,
      tone: 'info' as const,
    })),
    ...(jobFailures.data ?? []).slice(0, 20).map((j) => ({
      id: `job-${j.id}`,
      kind: 'job_failure' as const,
      title: `Scheduled job failed: ${j.job_type}`,
      detail: j.error_message ?? 'No error detail recorded',
      at: j.started_at,
      tone: 'danger' as const,
    })),
    ...(amlFlags.data ?? []).slice(0, 20).map((f) => ({
      id: `aml-${f.id}`,
      kind: 'aml_flag' as const,
      title: 'AML flag raised',
      detail: `${f.transaction_type} transaction flagged for review`,
      at: f.flagged_at,
      tone: 'danger' as const,
    })),
    ...(approvals.data ?? []).slice(0, 20).map((a) => ({
      id: `approval-${a.id}`,
      kind: 'approval' as const,
      title: `Approval pending: ${a.action_type}`,
      detail: a.amount_pesewas ? `Amount: GHS ${(Number(a.amount_pesewas) / 100).toFixed(2)}` : 'Awaiting review',
      at: a.created_at,
      tone: 'warning' as const,
    })),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  return {
    items,
    isLoading: reminders.isLoading || jobFailures.isLoading || amlFlags.isLoading || approvals.isLoading,
  };
}
