import { NavLink } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import { useAuth } from '../auth/AuthContext';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Any one of these permission codes grants visibility; omit to always show. */
  anyOf?: string[];
}

export interface NavGroup {
  label?: string;
  items: NavItem[];
}

interface SidebarProps {
  groups: NavGroup[];
  collapsed: boolean;
  brand: { label: string; sublabel: string };
}

/**
 * Fixed 230-250px on desktop, collapsible to an icon-only rail on tablet
 * (Section 3.3) — collapse behavior lives in the parent layout (persisted
 * per platform), this component just renders either width. Mobile drawer
 * behavior is handled by the parent layout swapping this for an off-canvas
 * panel below the tablet breakpoint.
 */
export function Sidebar({ groups, collapsed, brand }: SidebarProps) {
  const { hasAnyPermission } = useAuth();

  return (
    <nav
      aria-label="Primary"
      className={clsx(
        'flex h-full flex-col border-r border-border bg-sidebar-bg text-white transition-[width]',
        collapsed ? 'w-[var(--sidebar-width-rail)]' : 'w-[var(--sidebar-width)]'
      )}
    >
      <div className="flex h-14 items-center gap-2 border-b border-white/10 px-4">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-white/10 text-sm font-bold">
          SC
        </span>
        {!collapsed && (
          <div className="min-w-0">
            <p className="truncate text-[13px] font-semibold leading-tight">{brand.label}</p>
            <p className="truncate text-[11px] leading-tight text-white/60">{brand.sublabel}</p>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-3">
        {groups.map((group, gi) => {
          const visibleItems = group.items.filter((item) => !item.anyOf || hasAnyPermission(item.anyOf));
          if (visibleItems.length === 0) return null;
          return (
            <div key={gi} className="mb-4">
              {group.label && !collapsed && (
                <p className="px-3 pb-1 text-[11px] font-semibold tracking-wide text-white/50 uppercase">
                  {group.label}
                </p>
              )}
              <ul className="flex flex-col gap-0.5">
                {visibleItems.map((item) => (
                  <li key={item.to}>
                    <NavLink
                      to={item.to}
                      className={({ isActive }) =>
                        clsx(
                          'flex items-center gap-2.5 rounded-md px-3 py-2 text-[13px] font-medium transition-colors',
                          isActive ? 'bg-white/15 text-white' : 'text-white/75 hover:bg-white/10 hover:text-white'
                        )
                      }
                      title={collapsed ? item.label : undefined}
                    >
                      <item.icon size={17} className="shrink-0" aria-hidden="true" />
                      {!collapsed && <span className="truncate">{item.label}</span>}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </nav>
  );
}
