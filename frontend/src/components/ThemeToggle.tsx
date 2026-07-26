import { Sun, Moon, MonitorCog } from 'lucide-react';
import clsx from 'clsx';
import { useThemePreferences, type ThemeMode } from '../theme/ThemeContext';

const OPTIONS: { mode: ThemeMode; label: string; icon: typeof Sun }[] = [
  { mode: 'light', label: 'Light', icon: Sun },
  { mode: 'dark', label: 'Dark', icon: Moon },
  { mode: 'system', label: 'Match device', icon: MonitorCog },
];

export function ThemeToggle() {
  const { themeMode, setThemeMode } = useThemePreferences();
  return (
    <div role="radiogroup" aria-label="Theme" className="flex items-center gap-0.5 rounded-md border border-border bg-surface-alt p-0.5">
      {OPTIONS.map(({ mode, label, icon: Icon }) => (
        <button
          key={mode}
          type="button"
          role="radio"
          aria-checked={themeMode === mode}
          title={label}
          onClick={() => setThemeMode(mode)}
          className={clsx(
            'flex size-7 items-center justify-center rounded transition-colors',
            themeMode === mode ? 'bg-surface text-text-primary shadow-sm' : 'text-text-muted hover:text-text-secondary'
          )}
        >
          <Icon size={14} aria-hidden="true" />
          <span className="sr-only">{label}</span>
        </button>
      ))}
    </div>
  );
}
