interface BadgeProps {
  children: React.ReactNode;
  variant?: 'default' | 'accent' | 'success' | 'warning' | 'error';
  className?: string;
}

const variantStyles: Record<NonNullable<BadgeProps['variant']>, string> = {
  default: 'bg-[var(--bg-overlay)] text-[var(--text-secondary)]',
  accent: 'bg-[var(--accent-dim)] text-[var(--accent)]',
  success: 'bg-[var(--score-excellent-bg)] text-[var(--score-excellent)]',
  warning: 'bg-[var(--score-mid-bg)] text-[var(--score-mid)]',
  error: 'bg-[var(--score-fail-bg)] text-[var(--score-fail)]',
};

export function Badge({ children, variant = 'default', className = '' }: BadgeProps) {
  return (
    <span
      className={`
        inline-flex items-center px-2 py-0.5 rounded-md
        font-mono text-xs font-medium
        ${variantStyles[variant]}
        ${className}
      `}
    >
      {children}
    </span>
  );
}
