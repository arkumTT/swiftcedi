import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, CornerDownLeft } from 'lucide-react';
import clsx from 'clsx';
import type { NavGroup } from './Sidebar';
import { useAuth } from '../auth/AuthContext';

/**
 * Cmd/Ctrl+K universal navigation jump (Section 9 recommendation #1). Scoped
 * honestly to navigating between screens — there's no backend full-text
 * search across customers/loans/transactions today (customers/loans list
 * endpoints only support structured filters, not a name/id search box), so
 * this doesn't pretend to search records it can't actually query; each
 * feature's own list screen has its own real filter/search toolbar for that.
 */
interface CommandPaletteProps {
  navGroups: NavGroup[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CommandPalette({ navGroups, open, onOpenChange }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { hasAnyPermission } = useAuth();

  const commands = useMemo(
    () =>
      navGroups
        .flatMap((g) => g.items)
        .filter((item) => !item.anyOf || hasAnyPermission(item.anyOf)),
    [navGroups, hasAnyPermission]
  );

  const filtered = useMemo(() => {
    if (!query.trim()) return commands;
    const q = query.toLowerCase();
    return commands.filter((c) => c.label.toLowerCase().includes(q));
  }, [commands, query]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        onOpenChange(!open);
      }
      if (e.key === 'Escape') onOpenChange(false);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  if (!open) return null;

  function go(to: string) {
    navigate(to);
    onOpenChange(false);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-[color-mix(in_srgb,black_45%,transparent)] pt-[15vh]"
      onClick={() => onOpenChange(false)}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg overflow-hidden rounded-card border border-border bg-surface shadow-[var(--shadow-elevation)]"
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <Search size={16} className="text-text-muted" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActiveIndex((i) => Math.max(i - 1, 0));
              }
              if (e.key === 'Enter' && filtered[activeIndex]) {
                go(filtered[activeIndex].to);
              }
            }}
            placeholder="Jump to a screen…"
            className="w-full bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted"
          />
        </div>
        <ul className="max-h-80 overflow-y-auto py-1" role="listbox">
          {filtered.length === 0 && <li className="px-4 py-6 text-center text-[13px] text-text-secondary">No matching screen</li>}
          {filtered.map((item, i) => (
            <li key={item.to}>
              <button
                type="button"
                role="option"
                aria-selected={i === activeIndex}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => go(item.to)}
                className={clsx(
                  'flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm',
                  i === activeIndex ? 'bg-surface-alt text-text-primary' : 'text-text-secondary'
                )}
              >
                <item.icon size={15} aria-hidden="true" />
                <span className="flex-1 truncate">{item.label}</span>
                {i === activeIndex && <CornerDownLeft size={13} className="text-text-muted" aria-hidden="true" />}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
