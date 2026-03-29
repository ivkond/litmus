import { Card } from './ui/card';

interface StatCardProps {
  label: string;
  value: string | number;
  subtitle?: string;
}

export function StatCard({ label, value, subtitle }: StatCardProps) {
  return (
    <Card>
      <p className="text-xs font-mono uppercase tracking-wider text-[var(--text-muted)] mb-1">
        {label}
      </p>
      <p className="text-2xl font-mono font-semibold text-[var(--text-primary)]">
        {value}
      </p>
      {subtitle && (
        <p className="text-xs text-[var(--text-secondary)] mt-1">{subtitle}</p>
      )}
    </Card>
  );
}
