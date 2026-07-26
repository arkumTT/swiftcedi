import { Card } from '../../components/Card';
import { useThemePreferences, type Density, type ThemeMode } from '../../theme/ThemeContext';
import { useAuth } from '../../auth/AuthContext';
import clsx from 'clsx';

function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="inline-flex rounded-md border border-border bg-surface-alt p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={clsx(
            'rounded px-3 py-1.5 text-[13px] font-medium transition-colors',
            value === opt.value ? 'bg-surface text-text-primary shadow-sm' : 'text-text-secondary'
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between py-3">
      <div>
        <p className="text-[13px] font-medium text-text-primary">{label}</p>
        <p className="text-[12.5px] text-text-secondary">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={clsx(
          'relative h-6 w-11 shrink-0 rounded-full transition-colors',
          checked ? 'bg-primary' : 'bg-surface-alt border border-border'
        )}
      >
        <span
          className={clsx(
            'absolute top-0.5 size-5 rounded-full bg-white shadow transition-transform',
            checked ? 'translate-x-[22px]' : 'translate-x-0.5'
          )}
        />
      </button>
    </div>
  );
}

export function SettingsPage() {
  const {
    themeMode,
    setThemeMode,
    density,
    setDensity,
    reducedMotion,
    setReducedMotion,
    highContrast,
    setHighContrast,
    largeText,
    setLargeText,
  } = useThemePreferences();
  const { user, logout } = useAuth();

  return (
    <div className="flex flex-col gap-4">
      <Card title="Appearance">
        <div className="flex flex-col divide-y divide-border">
          <div className="flex items-center justify-between py-3">
            <div>
              <p className="text-[13px] font-medium text-text-primary">Theme</p>
              <p className="text-[12.5px] text-text-secondary">Light and dark are both first-class — pick one, or match your device.</p>
            </div>
            <SegmentedControl<ThemeMode>
              value={themeMode}
              onChange={setThemeMode}
              options={[
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
                { value: 'system', label: 'Match device' },
              ]}
            />
          </div>
          <div className="flex items-center justify-between py-3">
            <div>
              <p className="text-[13px] font-medium text-text-primary">Density</p>
              <p className="text-[12.5px] text-text-secondary">Compact tightens table rows and card padding for high-volume work.</p>
            </div>
            <SegmentedControl<Density>
              value={density}
              onChange={setDensity}
              options={[
                { value: 'comfortable', label: 'Comfortable' },
                { value: 'compact', label: 'Compact' },
              ]}
            />
          </div>
        </div>
      </Card>

      <Card title="Accessibility">
        <div className="flex flex-col divide-y divide-border">
          <ToggleRow
            label="Reduce motion"
            description="Minimizes animation, independent of your OS setting."
            checked={reducedMotion}
            onChange={setReducedMotion}
          />
          <ToggleRow
            label="High contrast"
            description="Strengthens borders and secondary text for better legibility."
            checked={highContrast}
            onChange={setHighContrast}
          />
          <ToggleRow
            label="Larger text"
            description="Increases the base font size across the app."
            checked={largeText}
            onChange={setLargeText}
          />
        </div>
      </Card>

      <Card title="Account">
        <div className="flex flex-col gap-1 text-[13px]">
          <p>
            <span className="text-text-secondary">Name: </span>
            <span className="text-text-primary">{user?.fullName}</span>
          </p>
          <p>
            <span className="text-text-secondary">Email: </span>
            <span className="text-text-primary">{user?.email}</span>
          </p>
          <p>
            <span className="text-text-secondary">Role: </span>
            <span className="capitalize text-text-primary">{user?.roleName.replace(/_/g, ' ')}</span>
          </p>
        </div>
      </Card>

      <Card title="Session & security">
        <p className="mb-3 text-[13px] text-text-secondary">
          This platform currently tracks a single active session per sign-in rather than a
          multi-device session list, and 2FA enrollment isn't wired up yet — both are flagged as
          follow-up work in Decisions_Log.md. Signing out here ends your current session immediately.
        </p>
        <button
          type="button"
          onClick={() => logout()}
          className="rounded-md border border-danger/30 bg-danger/10 px-3 py-1.5 text-[13px] font-medium text-danger"
        >
          Sign out of this session
        </button>
      </Card>
    </div>
  );
}
