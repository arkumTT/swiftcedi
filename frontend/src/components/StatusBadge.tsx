import { CheckCircle2, Clock, XCircle, Ban, Info } from 'lucide-react';
import clsx from 'clsx';

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

const toneClasses: Record<Tone, string> = {
  success: 'bg-success/12 text-success border-success/25',
  warning: 'bg-warning/14 text-warning-text-strong border-warning/30',
  danger: 'bg-danger/12 text-danger border-danger/25',
  info: 'bg-info/12 text-info border-info/25',
  neutral: 'bg-surface-alt text-text-secondary border-border',
};

const toneIcons: Record<Tone, typeof CheckCircle2> = {
  success: CheckCircle2,
  warning: Clock,
  danger: XCircle,
  info: Info,
  neutral: Ban,
};

/**
 * Consistent vocabulary across every module and both platforms (Section 3.4
 * / Section 2 "Consistent vocabulary" principle) — the same status word
 * always maps to the same tone here, so screens pass a raw backend status
 * string and never redefine this mapping themselves. Extend this map
 * instead of introducing a one-off color in a feature screen.
 */
const STATUS_TONE: Record<string, Tone> = {
  active: 'success',
  posted: 'success',
  approved: 'success',
  verified: 'success',
  disbursed: 'success',
  paid: 'success',
  matched: 'success',
  resolved: 'success',
  cleared: 'success',
  success: 'success',
  completed: 'success',
  reconciled: 'success',

  pending: 'warning',
  pending_approval: 'warning',
  pending_review: 'warning',
  applied: 'warning',
  appraised: 'warning',
  under_review: 'warning',
  running: 'warning',
  generated: 'warning',

  suspended: 'danger',
  locked: 'danger',
  flagged: 'danger',
  overdue: 'danger',
  rejected: 'danger',
  failed: 'danger',
  written_off: 'danger',
  disabled: 'danger',
  potential_match: 'danger',
  confirmed_match: 'danger',
  reversed: 'info',

  closed: 'neutral',
  inactive: 'neutral',
  cancelled: 'neutral',
  paused: 'neutral',
  expired: 'neutral',
  no_match: 'neutral',
  dormant: 'neutral',
};

function humanize(value: string): string {
  return value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

interface StatusBadgeProps {
  status: string;
  /** Override the auto-resolved tone when a status string is ambiguous across modules. */
  tone?: Tone;
  label?: string;
}

export function StatusBadge({ status, tone, label }: StatusBadgeProps) {
  const resolvedTone = tone ?? STATUS_TONE[status] ?? 'neutral';
  const Icon = toneIcons[resolvedTone];
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-pill border px-2.5 py-0.5 text-[12px] font-medium whitespace-nowrap',
        toneClasses[resolvedTone]
      )}
    >
      <Icon size={12} aria-hidden="true" />
      {label ?? humanize(status)}
    </span>
  );
}
