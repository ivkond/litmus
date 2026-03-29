'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ThemeToggle } from './theme-toggle';

const NAV_ITEMS = [
  { href: '/', label: 'Dashboard' },
  { href: '/run', label: 'Run' },
  { href: '/compare', label: 'Compare' },
  { href: '/scenarios', label: 'Scenarios' },
  { href: '/settings', label: 'Settings' },
] as const;

export function NavBar() {
  const pathname = usePathname();

  return (
    <nav className="flex items-center justify-between h-12 mb-6">
      {/* Logo */}
      <Link
        href="/"
        className="font-mono text-sm font-bold text-[var(--accent)] tracking-wider"
      >
        LITMUS
      </Link>

      {/* Pill navigation (desktop-only; mobile hamburger deferred to Phase 4) */}
      <div className="
        flex items-center gap-1
        bg-[var(--bg-raised)] border border-[var(--border)]
        rounded-full px-1.5 py-1
      ">
        {NAV_ITEMS.map((item) => {
          const isActive = item.href === '/'
            ? pathname === '/'
            : pathname.startsWith(item.href);

          return (
            <Link
              key={item.href}
              href={item.href}
              className={`
                font-mono text-xs px-3 py-1 rounded-full transition-colors
                ${isActive
                  ? 'bg-[var(--accent-dim)] text-[var(--accent)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                }
              `}
            >
              {item.label}
            </Link>
          );
        })}
      </div>

      {/* Theme toggle */}
      <ThemeToggle />
    </nav>
  );
}
