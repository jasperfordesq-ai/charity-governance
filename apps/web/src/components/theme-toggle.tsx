'use client';

import { useEffect, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';

type Theme = 'light' | 'dark' | 'system';

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('system');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const stored = localStorage.getItem('theme') as Theme | null;
    setTheme(stored ?? 'system');
  }, []);

  useEffect(() => {
    if (!mounted) return;

    // Persist the choice; the dashboard layout resolves it to the .dark class (incl. 'system').
    if (theme === 'dark') {
      localStorage.setItem('theme', 'dark');
    } else if (theme === 'light') {
      localStorage.setItem('theme', 'light');
    } else {
      localStorage.removeItem('theme');
    }
    window.dispatchEvent(new Event('themechange'));
  }, [theme, mounted]);

  if (!mounted) return null;

  const cycle = () => {
    setTheme((prev) => (prev === 'light' ? 'dark' : prev === 'dark' ? 'system' : 'light'));
  };

  return (
    <button
      onClick={cycle}
      className="p-2 rounded-lg text-gray-500 hover:text-gray-700 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-800 transition-colors"
      aria-label={`Theme: ${theme}. Click to change.`}
      title={`Current: ${theme}`}
    >
      {theme === 'light' && (
        <Sun className="w-5 h-5" strokeWidth={1.5} aria-hidden="true" />
      )}
      {theme === 'dark' && (
        <Moon className="w-5 h-5" strokeWidth={1.5} aria-hidden="true" />
      )}
      {theme === 'system' && (
        <Monitor className="w-5 h-5" strokeWidth={1.5} aria-hidden="true" />
      )}
    </button>
  );
}
