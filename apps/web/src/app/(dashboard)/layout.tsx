'use client';

import { cloneElement, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { Button } from '@heroui/react';
import { useAuth } from '@/lib/auth-context';
import Link from 'next/link';
import { Breadcrumbs } from '@/components/breadcrumbs';
import { ThemeToggle } from '@/components/theme-toggle';
import { KeyboardShortcuts } from '@/components/keyboard-shortcuts';
import { SessionTimeout } from '@/components/session-timeout';
import {
  BookOpenCheck,
  Building2,
  CalendarDays,
  ClipboardCheck,
  CreditCard,
  Download,
  FileText,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  Menu,
  ShieldCheck,
  UserRoundCog,
  UsersRound,
  X,
} from 'lucide-react';

/* ------------------------------------------------------------------ */
/*  Navigation items                                                  */
/* ------------------------------------------------------------------ */

const navIconClassName = 'w-5 h-5';

const NAV_ITEMS = [
  {
    href: '/dashboard',
    label: 'Dashboard',
    icon: <LayoutDashboard className={navIconClassName} strokeWidth={1.5} aria-hidden="true" />,
  },
  {
    href: '/compliance',
    label: 'Compliance',
    icon: <ClipboardCheck className={navIconClassName} strokeWidth={1.5} aria-hidden="true" />,
  },
  {
    href: '/regulator',
    label: 'Regulator Guide',
    icon: <ShieldCheck className={navIconClassName} strokeWidth={1.5} aria-hidden="true" />,
  },
  {
    href: '/documents',
    label: 'Documents',
    icon: <FileText className={navIconClassName} strokeWidth={1.5} aria-hidden="true" />,
  },
  {
    href: '/board',
    label: 'Board',
    icon: <UsersRound className={navIconClassName} strokeWidth={1.5} aria-hidden="true" />,
  },
  {
    href: '/registers',
    label: 'Registers',
    icon: <BookOpenCheck className={navIconClassName} strokeWidth={1.5} aria-hidden="true" />,
  },
  {
    href: '/deadlines',
    label: 'Deadlines',
    icon: <CalendarDays className={navIconClassName} strokeWidth={1.5} aria-hidden="true" />,
  },
  {
    href: '/organisation',
    label: 'Organisation',
    icon: <Building2 className={navIconClassName} strokeWidth={1.5} aria-hidden="true" />,
  },
  {
    href: '/team',
    label: 'Team',
    icon: <UserRoundCog className={navIconClassName} strokeWidth={1.5} aria-hidden="true" />,
  },
  {
    href: '/billing',
    label: 'Billing',
    icon: <CreditCard className={navIconClassName} strokeWidth={1.5} aria-hidden="true" />,
  },
  {
    href: '/export',
    label: 'Export',
    icon: <Download className={navIconClassName} strokeWidth={1.5} aria-hidden="true" />,
  },
];

/* ------------------------------------------------------------------ */
/*  Layout component                                                  */
/* ------------------------------------------------------------------ */

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { user, isLoading, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isDesktopNav, setIsDesktopNav] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarId = 'dashboard-primary-navigation';
  const navInteractive = isDesktopNav || sidebarOpen;

  const closeSidebar = useCallback((restoreFocus = false) => {
    setSidebarOpen(false);
    if (restoreFocus) {
      menuButtonRef.current?.focus();
    }
  }, []);

  // Resolve and apply the theme as a .dark class. The root layout pre-paints this for
  // every route; this client effect keeps dashboard theme changes and system changes live.
  useEffect(() => {
    const root = document.documentElement;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const stored = localStorage.getItem('theme');
      const dark = stored === 'dark' || (stored !== 'light' && mq.matches);
      root.classList.toggle('dark', dark);
    };
    apply();
    mq.addEventListener('change', apply);
    window.addEventListener('themechange', apply);
    return () => {
      mq.removeEventListener('change', apply);
      window.removeEventListener('themechange', apply);
    };
  }, []);

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const syncDesktopNav = () => setIsDesktopNav(mq.matches);
    syncDesktopNav();
    mq.addEventListener('change', syncDesktopNav);
    return () => mq.removeEventListener('change', syncDesktopNav);
  }, []);

  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!sidebarOpen) return;

    const firstLink = sidebarRef.current?.querySelector<HTMLElement>('a[href]');
    firstLink?.focus();

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeSidebar(true);
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [closeSidebar, sidebarOpen]);

  // Redirect unauthenticated users
  useEffect(() => {
    if (!isLoading && !user) {
      // Preserve the intended destination so login can return the user here
      // (safeNextPath validates it). Without this, deep links land on /dashboard.
      const next = `${window.location.pathname}${window.location.search}`;
      router.replace(`/login?next=${encodeURIComponent(next)}`);
      return;
    }

    if (!isLoading && user && !user.emailVerified) {
      router.replace('/verify-email');
    }
  }, [isLoading, user, router]);

  // Loading state
  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-50 dark:bg-gray-950">
        <div className="flex flex-col items-center gap-3">
          <LoaderCircle className="animate-spin h-10 w-10 text-teal-primary" aria-hidden="true" />
          <p className="text-sm text-gray-500 dark:text-gray-400">Loading CharityPilot...</p>
        </div>
      </div>
    );
  }

  if (!user || !user.emailVerified) return null;

  const isActive = (href: string) => {
    if (href === '/dashboard') return pathname === '/dashboard';
    return pathname.startsWith(href);
  };

  return (
    <div data-app="dashboard" className="flex min-h-screen bg-gray-50 dark:bg-gray-950">
      {/* Skip to content — a11y */}
      <a href="#dashboard-content" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[100] focus:bg-teal-primary focus:text-white focus:px-4 focus:py-2 focus:rounded-lg focus:text-sm focus:font-semibold">
        Skip to content
      </a>
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          aria-hidden="true"
          className="fixed inset-0 z-30 bg-black/40 lg:hidden"
          onClick={() => closeSidebar(true)}
        />
      )}

      {/* Sidebar */}
      <aside
        id={sidebarId}
        ref={sidebarRef}
        aria-label="Primary navigation"
        aria-hidden={!navInteractive ? true : undefined}
        className={`
          fixed inset-y-0 left-0 z-40 w-64 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 transform transition-transform duration-200 ease-in-out
          lg:translate-x-0 lg:static lg:z-auto
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
        `}
      >
        {/* Logo */}
        <div className="flex items-center gap-2.5 px-5 h-16 border-b border-gray-200 dark:border-gray-800">
          <div className="w-8 h-8 rounded-lg bg-teal-primary flex items-center justify-center">
            <ShieldCheck className="w-5 h-5 text-white" strokeWidth={2} aria-hidden="true" />
          </div>
          <span className="text-lg font-bold text-teal-primary">CharityPilot</span>
        </div>

        {/* Navigation links */}
        <nav className="flex flex-col gap-0.5 p-3 mt-2">
          {NAV_ITEMS.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                tabIndex={navInteractive ? undefined : -1}
                onClick={() => setSidebarOpen(false)}
                className={`
                  flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors
                  ${active
                    ? 'bg-teal-primary/10 text-teal-primary'
                    : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100'
                  }
                `}
              >
                <span className="flex-shrink-0" aria-hidden="true">
                  {cloneElement(item.icon, { focusable: false })}
                </span>
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* Sidebar footer */}
        <div className="absolute bottom-0 left-0 right-0 p-4 border-t border-gray-200 dark:border-gray-800">
          <div className="text-xs text-gray-400 dark:text-gray-400 text-center space-y-1">
            <p>CharityPilot v1.0</p>
            <p className="hidden lg:block">Press <kbd className="px-1 py-0.5 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded text-[10px] font-mono">?</kbd> for shortcuts</p>
          </div>
        </div>
      </aside>

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <header className="sticky top-0 z-20 flex items-center justify-between h-16 px-4 sm:px-6 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800">
          {/* Mobile menu button */}
          <button
            ref={menuButtonRef}
            type="button"
            aria-label={sidebarOpen ? 'Close sidebar menu' : 'Open sidebar menu'}
            aria-controls={sidebarId}
            aria-expanded={sidebarOpen}
            className="lg:hidden p-2 -ml-2 rounded-md text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
            onClick={() => setSidebarOpen((open) => !open)}
          >
            {sidebarOpen ? (
              <X className="w-6 h-6" strokeWidth={1.5} aria-hidden="true" />
            ) : (
              <Menu className="w-6 h-6" strokeWidth={1.5} aria-hidden="true" />
            )}
          </button>

          {/* Organisation name */}
          <div className="hidden lg:block">
            <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">{user.organisation?.name ?? 'My Organisation'}</h2>
          </div>

          {/* User info + logout */}
          <div className="flex items-center gap-3 ml-auto">
            <ThemeToggle />
            <div className="text-right hidden sm:block">
              <p className="text-sm font-medium text-gray-800 dark:text-gray-100">{user.name}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400">{user.organisation?.name ?? ''}</p>
            </div>
            <div className="w-8 h-8 rounded-full bg-teal-primary/10 text-teal-primary flex items-center justify-center text-sm font-semibold">
              {user.name?.charAt(0)?.toUpperCase() ?? 'U'}
            </div>
            <Button
              size="sm"
              variant="flat"
              color="danger"
              // Contrast: the default danger-flat label is just under WCAG AA in both themes
              // (light 4.4:1 #c20e4d on the danger-100 tint, dark 4.34:1). Darken it in light
              // and brighten it in dark to clear 4.5:1.
              className="!text-[#a10b48] dark:!text-[#ff8fb3]"
              onPress={() => {
                logout();
                router.replace('/login');
              }}
            >
              <LogOut className="w-4 h-4" strokeWidth={2} aria-hidden="true" />
              Logout
            </Button>
          </div>
        </header>

        {/* Page content */}
        <main id="dashboard-content" className="flex-1 p-4 sm:p-6 lg:p-8 overflow-auto">
          <Breadcrumbs />
          {children}
        </main>
        <KeyboardShortcuts />
        <SessionTimeout />
      </div>
    </div>
  );
}
