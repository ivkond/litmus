'use client';

import { useEffect, useCallback, useSyncExternalStore } from 'react';

type Theme = 'dark' | 'light' | 'system';

function resolveTheme(t: Theme): 'dark' | 'light' {
  if (t !== 'system') return t;
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function getStoredTheme(): Theme {
  if (typeof window === 'undefined') return 'system';
  return (localStorage.getItem('litmus-theme') as Theme) ?? 'system';
}

// useSyncExternalStore for localStorage-backed theme — no setState-in-effect
function useThemeStore() {
  const subscribe = useCallback((callback: () => void) => {
    window.addEventListener('storage', callback);
    return () => window.removeEventListener('storage', callback);
  }, []);

  return useSyncExternalStore(subscribe, getStoredTheme, () => 'system' as Theme);
}

export function ThemeToggle() {
  const theme = useThemeStore();

  // Apply data-theme attribute whenever theme changes
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolveTheme(theme));
  }, [theme]);

  // Listen for OS theme changes when in system mode
  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      document.documentElement.setAttribute('data-theme', resolveTheme('system'));
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  function cycle() {
    const next: Theme = theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark';
    localStorage.setItem('litmus-theme', next);
    // Trigger useSyncExternalStore re-read
    window.dispatchEvent(new StorageEvent('storage', { key: 'litmus-theme' }));
  }

  const icons: Record<Theme, string> = {
    dark: '☽',
    light: '☀',
    system: '◑',
  };

  return (
    <button
      onClick={cycle}
      className="
        font-mono text-sm px-2 py-1 rounded-md
        text-[var(--text-secondary)]
        hover:text-[var(--text-primary)]
        hover:bg-[var(--bg-hover)]
        transition-colors
      "
      title={`Theme: ${theme}`}
    >
      {icons[theme]}
    </button>
  );
}
