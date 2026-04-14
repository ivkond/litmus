// web/src/components/nav-bar.tsx
'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { ThemeToggle } from './theme-toggle';

export const NAV_ITEMS = [
  { href: '/', label: 'Dashboard' },
  { href: '/run', label: 'Run' },
  { href: '/compare', label: 'Compare' },
  { href: '/scenarios', label: 'Scenarios' },
  { href: '/settings', label: 'Settings' },
] as const;

export function NavBar() {
  const pathname = usePathname();
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Close menu on Escape
  useEffect(() => {
    if (!isOpen) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setIsOpen(false);
        buttonRef.current?.focus();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  // Close menu on click outside
  useEffect(() => {
    if (!isOpen) return;

    function handleMouseDown(e: MouseEvent) {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
        buttonRef.current?.focus();
      }
    }

    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [isOpen]);

  function isActive(href: string): boolean {
    return href === '/' ? pathname === '/' : pathname.startsWith(href);
  }

  return (
    <nav className="relative mb-6">
      <div className="flex items-center justify-between h-12">
        {/* Logo */}
        <Link
          href="/"
          className="font-mono text-sm font-bold text-[var(--accent)] tracking-wider"
        >
          LITMUS
        </Link>

        {/* Desktop pill navigation (hidden on mobile) */}
        <div className="
          hidden md:flex items-center gap-1
          bg-[var(--bg-raised)] border border-[var(--border)]
          rounded-full px-1.5 py-1
        ">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`
                font-mono text-xs px-3 py-1 rounded-full transition-colors
                ${isActive(item.href)
                  ? 'bg-[var(--accent-dim)] text-[var(--accent)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                }
              `}
            >
              {item.label}
            </Link>
          ))}
        </div>

        {/* Desktop theme toggle (hidden on mobile) */}
        <div className="hidden md:block">
          <ThemeToggle />
        </div>

        {/* Mobile hamburger button (hidden on desktop) */}
        <button
          ref={buttonRef}
          onClick={() => setIsOpen(!isOpen)}
          aria-expanded={isOpen}
          aria-controls="mobile-menu"
          aria-label={isOpen ? 'Close menu' : 'Open menu'}
          className="md:hidden flex items-center justify-center w-11 h-11 text-[var(--text-primary)] font-mono text-lg"
        >
          {isOpen ? '\u2715' : '\u2630'}
        </button>
      </div>

      {/* Mobile dropdown overlay */}
      {isOpen && (
        <div
          ref={menuRef}
          id="mobile-menu"
          role="navigation"
          className="absolute left-0 right-0 top-12 z-50 border-b border-[var(--border)] bg-[var(--bg-overlay)] md:hidden"
        >
          <div className="flex flex-col py-2">
            {NAV_ITEMS.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setIsOpen(false)}
                className={`
                  flex items-center min-h-[44px] px-4 font-mono text-sm transition-colors
                  ${isActive(item.href)
                    ? 'bg-[var(--accent-dim)] text-[var(--accent)]'
                    : 'text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                  }
                `}
              >
                {item.label}
              </Link>
            ))}
            <div className="px-4 pt-2 pb-1 border-t border-[var(--border)] mt-2">
              <ThemeToggle />
            </div>
          </div>
        </div>
      )}
    </nav>
  );
}
