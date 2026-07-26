import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';
export type Density = 'comfortable' | 'compact';

interface Preferences {
  themeMode: ThemeMode;
  density: Density;
  reducedMotion: boolean;
  highContrast: boolean;
  largeText: boolean;
}

interface ThemeContextValue extends Preferences {
  setThemeMode: (mode: ThemeMode) => void;
  setDensity: (density: Density) => void;
  setReducedMotion: (value: boolean) => void;
  setHighContrast: (value: boolean) => void;
  setLargeText: (value: boolean) => void;
}

const STORAGE_KEY = 'swiftcedi.preferences';

const defaults: Preferences = {
  themeMode: 'system',
  density: 'comfortable',
  reducedMotion: false,
  highContrast: false,
  largeText: false,
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

function applyToDocument(prefs: Preferences) {
  const root = document.documentElement;
  if (prefs.themeMode === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', prefs.themeMode);

  root.setAttribute('data-density', prefs.density);
  root.setAttribute('data-reduced-motion', String(prefs.reducedMotion));
  root.setAttribute('data-contrast', prefs.highContrast ? 'high' : 'normal');
  root.setAttribute('data-font-scale', prefs.largeText ? 'large' : 'normal');
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<Preferences>(loadPreferences);

  useEffect(() => {
    applyToDocument(prefs);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  }, [prefs]);

  const update = useCallback(<K extends keyof Preferences>(key: K, value: Preferences[K]) => {
    setPrefs((prev) => ({ ...prev, [key]: value }));
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      ...prefs,
      setThemeMode: (mode) => update('themeMode', mode),
      setDensity: (density) => update('density', density),
      setReducedMotion: (v) => update('reducedMotion', v),
      setHighContrast: (v) => update('highContrast', v),
      setLargeText: (v) => update('largeText', v),
    }),
    [prefs, update]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useThemePreferences() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useThemePreferences must be used within ThemeProvider');
  return ctx;
}
