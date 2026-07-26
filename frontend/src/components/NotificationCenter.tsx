import { useRef, useState } from 'react';
import { Bell } from 'lucide-react';
import clsx from 'clsx';
import { useNotifications } from '../lib/notifications';
import { formatDateTime } from '../lib/format';
import { EmptyState } from './EmptyState';
import { useClickOutside } from '../hooks/useClickOutside';

const TONE_DOT: Record<string, string> = {
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
};

/** Persistent, filterable feed rather than toast-only pop-ups (Section 9 recommendation #2). */
export function NotificationCenter() {
  const [open, setOpen] = useState(false);
  const { items, isLoading } = useNotifications();
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setOpen(false));

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`Notifications${items.length ? `, ${items.length} unread` : ''}`}
        aria-expanded={open}
        className="relative flex size-8 items-center justify-center rounded-md text-text-secondary hover:bg-surface-alt"
      >
        <Bell size={17} />
        {items.length > 0 && (
          <span className="absolute top-1 right-1 flex size-2 rounded-full bg-danger" aria-hidden="true" />
        )}
      </button>
      {open && (
        <div className="absolute top-10 right-0 z-20 w-80 rounded-card border border-border bg-surface shadow-[var(--shadow-elevation)]">
          <div className="border-b border-border px-3 py-2">
            <h3 className="text-[13px] font-semibold text-text-primary">Notifications</h3>
          </div>
          <div className="max-h-96 overflow-y-auto">
            {isLoading && <p className="p-4 text-[13px] text-text-secondary">Loading…</p>}
            {!isLoading && items.length === 0 && (
              <EmptyState title="You're all caught up" description="No alerts, flags, or approvals need attention right now." />
            )}
            {items.map((item) => (
              <div key={item.id} className="flex gap-2 border-b border-border px-3 py-2.5 last:border-b-0">
                <span className={clsx('mt-1.5 size-2 shrink-0 rounded-full', TONE_DOT[item.tone])} aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-text-primary">{item.title}</p>
                  <p className="truncate text-[12.5px] text-text-secondary">{item.detail}</p>
                  <p className="text-[11.5px] text-text-muted">{formatDateTime(item.at)}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
