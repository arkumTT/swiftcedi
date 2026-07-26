import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PanelLeftClose, PanelLeftOpen, Search, Settings, LogOut, ChevronDown } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { ThemeToggle } from './ThemeToggle';
import { NotificationCenter } from './NotificationCenter';
import { useClickOutside } from '../hooks/useClickOutside';

interface TopBarProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onOpenCommandPalette: () => void;
  settingsPath: string;
}

export function TopBar({ collapsed, onToggleCollapsed, onOpenCommandPalette, settingsPath }: TopBarProps) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useClickOutside(menuRef, () => setMenuOpen(false));

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface px-3">
      <button
        type="button"
        onClick={onToggleCollapsed}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        className="flex size-8 items-center justify-center rounded-md text-text-secondary hover:bg-surface-alt"
      >
        {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
      </button>

      <button
        type="button"
        onClick={onOpenCommandPalette}
        className="flex h-8 w-64 items-center gap-2 rounded-md border border-border bg-surface-alt px-2.5 text-[13px] text-text-muted hover:border-accent"
      >
        <Search size={14} />
        <span className="flex-1 text-left">Jump to…</span>
        <kbd className="rounded border border-border bg-surface px-1 text-[10.5px]">⌘K</kbd>
      </button>

      <div className="ml-auto flex items-center gap-1.5">
        <ThemeToggle />
        <NotificationCenter />
        <div className="relative" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-expanded={menuOpen}
            className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-surface-alt"
          >
            <span className="flex size-7 items-center justify-center rounded-full bg-primary text-[12px] font-semibold text-white">
              {user?.fullName?.slice(0, 1)}
            </span>
            <span className="hidden text-left sm:block">
              <span className="block text-[13px] font-medium text-text-primary">{user?.fullName}</span>
              <span className="block text-[11.5px] text-text-secondary capitalize">
                {user?.roleName.replace(/_/g, ' ')}
              </span>
            </span>
            <ChevronDown size={14} className="text-text-muted" />
          </button>
          {menuOpen && (
            <div className="absolute top-11 right-0 z-20 w-48 rounded-card border border-border bg-surface py-1 shadow-[var(--shadow-elevation)]">
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  navigate(settingsPath);
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-text-primary hover:bg-surface-alt"
              >
                <Settings size={15} /> Settings
              </button>
              <button
                type="button"
                onClick={() => logout()}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-danger hover:bg-surface-alt"
              >
                <LogOut size={15} /> Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
