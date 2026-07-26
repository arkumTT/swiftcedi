import type { ReactNode } from 'react';
import { Search } from 'lucide-react';
import clsx from 'clsx';

interface Chip {
  label: string;
  active: boolean;
  onClick: () => void;
}

interface FilterToolbarProps {
  search?: { value: string; onChange: (value: string) => void; placeholder?: string };
  chips?: Chip[];
  children?: ReactNode;
}

/** Chip-style quick filters + search + dropdown-filter slot, top-right of any list panel (Section 3.4). */
export function FilterToolbar({ search, chips, children }: FilterToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
      {chips?.map((chip) => (
        <button
          key={chip.label}
          type="button"
          onClick={chip.onClick}
          className={clsx(
            'rounded-pill border px-3 py-1 text-[12.5px] font-medium transition-colors',
            chip.active
              ? 'border-primary bg-primary text-white'
              : 'border-border bg-surface text-text-secondary hover:bg-surface-alt'
          )}
        >
          {chip.label}
        </button>
      ))}
      <div className="ml-auto flex items-center gap-2">
        {children}
        {search && (
          <div className="relative">
            <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-text-muted" />
            <input
              value={search.value}
              onChange={(e) => search.onChange(e.target.value)}
              placeholder={search.placeholder ?? 'Search…'}
              className="h-8 w-56 rounded-md border border-border bg-surface pr-3 pl-8 text-[13px] text-text-primary focus-visible:border-accent"
            />
          </div>
        )}
      </div>
    </div>
  );
}
