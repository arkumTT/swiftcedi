import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type NotificationKind = 'reminder' | 'job_failure' | 'aml_flag' | 'approval';

type Preferences = Record<NotificationKind, boolean>;

const STORAGE_KEY = 'swiftcedi.notificationPreferences';

const defaults: Preferences = {
  reminder: true,
  job_failure: true,
  aml_flag: true,
  approval: true,
};

function loadPreferences(): Preferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    return defaults;
  }
}

interface NotificationPreferencesValue extends Preferences {
  setKindEnabled: (kind: NotificationKind, enabled: boolean) => void;
}

const NotificationPreferencesContext = createContext<NotificationPreferencesValue | null>(null);

/** In-app category toggles for the Notification Center (Section 8's "notification preferences" recommendation) — localStorage-only, same as ThemeContext, since there's no per-user preferences table. Email/SMS channels aren't wired up (no delivery infrastructure exists), so this only ever controls the in-app feed. */
export function NotificationPreferencesProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<Preferences>(loadPreferences);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  }, [prefs]);

  const value: NotificationPreferencesValue = {
    ...prefs,
    setKindEnabled: (kind, enabled) => setPrefs((prev) => ({ ...prev, [kind]: enabled })),
  };

  return <NotificationPreferencesContext.Provider value={value}>{children}</NotificationPreferencesContext.Provider>;
}

export function useNotificationPreferences() {
  const ctx = useContext(NotificationPreferencesContext);
  if (!ctx) throw new Error('useNotificationPreferences must be used within NotificationPreferencesProvider');
  return ctx;
}
