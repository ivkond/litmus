import { db } from '@/db';
import { scenarios } from '@/db/schema';
import { asc } from 'drizzle-orm';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export const dynamic = 'force-dynamic';

export default async function ScenariosPage() {
  const rows = await db
    .select()
    .from(scenarios)
    .orderBy(asc(scenarios.slug));

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h1 className="font-mono text-lg text-[var(--text-primary)]">Scenarios</h1>
        <span className="font-mono text-xs text-[var(--text-muted)]">
          {rows.length} {rows.length === 1 ? 'scenario' : 'scenarios'}
        </span>
      </div>

      <p className="text-xs text-[var(--text-muted)] font-mono">
        Import via <code className="text-[var(--accent)]">POST /api/scenarios/import</code>.
        Full CRUD coming in Phase 3.
      </p>

      {rows.length === 0 ? (
        <Card>
          <p className="text-sm text-[var(--text-muted)]">
            No scenarios imported yet. Use the import API to add scenarios.
          </p>
        </Card>
      ) : (
        <Card>
          <table className="w-full">
            <thead>
              <tr className="border-b border-[var(--border)]">
                {['Name', 'Slug', 'Language', 'Version'].map((h) => (
                  <th
                    key={h}
                    className="font-mono text-xs text-[var(--text-muted)] text-left py-2 px-3"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((scenario) => (
                <tr
                  key={scenario.id}
                  className="border-b border-[var(--border)] last:border-0"
                >
                  <td className="text-sm text-[var(--text-primary)] py-2 px-3">
                    {scenario.name}
                  </td>
                  <td className="py-2 px-3">
                    <code className="font-mono text-xs text-[var(--text-secondary)]">
                      {scenario.slug}
                    </code>
                  </td>
                  <td className="py-2 px-3">
                    {scenario.language ? (
                      <Badge variant="accent">{scenario.language}</Badge>
                    ) : (
                      <span className="font-mono text-xs text-[var(--text-muted)]">—</span>
                    )}
                  </td>
                  <td className="font-mono text-xs text-[var(--text-muted)] py-2 px-3">
                    {scenario.version ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
