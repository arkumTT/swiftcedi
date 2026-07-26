import { useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { Sidebar, type NavGroup } from '../components/Sidebar';
import { TopBar } from '../components/TopBar';
import { CommandPalette } from '../components/CommandPalette';

interface AppShellProps {
  navGroups: NavGroup[];
  brand: { label: string; sublabel: string };
  settingsPath: string;
  collapseStorageKey: string;
}

/**
 * The one shell both platforms render through — Sidebar + TopBar +
 * CommandPalette + <Outlet/>. Section 5's responsive strategy (sidebar
 * collapses to an icon rail at the tablet breakpoint, an off-canvas drawer
 * below it) is implemented here once rather than per platform.
 */
export function AppShell({ navGroups, brand, settingsPath, collapseStorageKey }: AppShellProps) {
  const [collapsed, setCollapsed] = useState(() => {
    if (window.innerWidth < 1280) return true;
    return localStorage.getItem(collapseStorageKey) === 'true';
  });
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    localStorage.setItem(collapseStorageKey, String(collapsed));
  }, [collapsed, collapseStorageKey]);

  return (
    <div className="flex h-svh bg-page-bg">
      <div className="hidden md:block">
        <Sidebar groups={navGroups} collapsed={collapsed} brand={brand} />
      </div>

      {mobileNavOpen && (
        <div className="fixed inset-0 z-30 flex md:hidden">
          <div className="w-64">
            <Sidebar groups={navGroups} collapsed={false} brand={brand} />
          </div>
          <button
            type="button"
            aria-label="Close navigation"
            className="flex-1 bg-black/40"
            onClick={() => setMobileNavOpen(false)}
          />
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          collapsed={collapsed}
          onToggleCollapsed={() => {
            if (window.innerWidth < 768) setMobileNavOpen((v) => !v);
            else setCollapsed((v) => !v);
          }}
          onOpenCommandPalette={() => setPaletteOpen(true)}
          settingsPath={settingsPath}
        />
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[var(--content-max-width)] p-4 md:p-6">
            <Outlet />
          </div>
        </main>
      </div>

      <CommandPalette navGroups={navGroups} open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}
