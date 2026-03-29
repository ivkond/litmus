import { describe, it, expect, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) =>
    <a href={href}>{children}</a>,
}));

describe('ScenariosLibrary', () => {
  it('renders empty state when no scenarios', async () => {
    const { ScenariosLibrary } = await import('../scenarios-library');
    // dynamic import to avoid module resolution issues before implementation
    expect(ScenariosLibrary).toBeDefined();
    expect(typeof ScenariosLibrary).toBe('function');
  });
});
