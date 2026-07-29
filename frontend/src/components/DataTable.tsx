import type { ReactNode } from 'react';
import clsx from 'clsx';
import { EmptyState } from './EmptyState';
import { ErrorState } from './ErrorState';

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  align?: 'left' | 'right' | 'center';
  className?: string;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  getRowKey: (row: T) => string | number;
  isLoading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: ReactNode;
  onRowClick?: (row: T) => void;
  rowActions?: (row: T) => ReactNode;
}

/**
 * Sticky header, border-separated (never zebra-striped) rows per Section
 * 3.4's "calmer financial-data feel," row-level actions revealed on
 * hover/focus. Every list screen renders through this one component so the
 * empty/error states, column alignment, and row-action pattern stay
 * consistent across every module.
 */
export function DataTable<T>({
  columns,
  rows,
  getRowKey,
  isLoading,
  error,
  onRetry,
  emptyTitle = 'Nothing here yet',
  emptyDescription,
  emptyAction,
  onRowClick,
  rowActions,
}: DataTableProps<T>) {
  if (error) return <ErrorState message={error} onRetry={onRetry} />;
  if (!isLoading && rows.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} action={emptyAction} />;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="sticky top-0 bg-surface-alt">
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                className={clsx(
                  'border-b border-border px-3 py-2 text-[11.5px] font-semibold tracking-wide text-text-secondary uppercase',
                  col.align === 'right' && 'text-right',
                  col.align === 'center' && 'text-center',
                  col.align !== 'right' && col.align !== 'center' && 'text-left'
                )}
              >
                {col.header}
              </th>
            ))}
            {rowActions && <th scope="col" className="border-b border-border px-3 py-2" />}
          </tr>
        </thead>
        <tbody>
          {isLoading && rows.length === 0
            ? Array.from({ length: 5 }).map((_, i) => (
                <tr key={i} className="border-b border-border">
                  {columns.map((col) => (
                    <td key={col.key} className="px-3 py-2.5">
                      <div className="h-3.5 w-3/4 animate-pulse rounded bg-surface-alt" />
                    </td>
                  ))}
                  {rowActions && <td />}
                </tr>
              ))
            : rows.map((row) => (
                <tr
                  key={getRowKey(row)}
                  className={clsx(
                    'group border-b border-border last:border-b-0',
                    onRowClick && 'cursor-pointer hover:bg-surface-alt'
                  )}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  onKeyDown={
                    onRowClick
                      ? (e) => {
                          if (e.key === 'Enter') onRowClick(row);
                        }
                      : undefined
                  }
                >
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={clsx(
                        'px-3 py-2.5 text-text-primary',
                        col.align === 'right' && 'text-right',
                        col.align === 'center' && 'text-center',
                        col.className
                      )}
                    >
                      {col.render(row)}
                    </td>
                  ))}
                  {rowActions && (
                    <td
                      className="px-3 py-2.5 text-right opacity-0 focus-within:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {rowActions(row)}
                    </td>
                  )}
                </tr>
              ))}
        </tbody>
      </table>
    </div>
  );
}
