import Link from 'next/link';
import { getDashboardStats, getRecentRuns } from '@/db/queries';
import { StatCard } from '@/components/stat-card';
import { Card } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const stats = await getDashboardStats();
  const recentRuns = await getRecentRuns();
  const hasData = stats.runs > 0;

  return (
    <div className="space-y-6">
      {/* Stats row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Total Runs" value={stats.runs} />
        <StatCard label="Agents" value={stats.agents} />
        <StatCard label="Models" value={stats.models} />
        <StatCard label="Avg Score" value={`${stats.avgScore}%`} />
      </div>

      {/* Quick actions */}
      <div className="grid grid-cols-2 gap-4">
        <Link href="/run">
          <Card hover>
            <p className="font-mono text-sm text-[var(--accent)] font-semibold">
              + New Run
            </p>
            <p className="text-xs text-[var(--text-secondary)] mt-1">
              Configure agents, models, and scenarios
            </p>
          </Card>
        </Link>
        {hasData ? (
          <Link href="/compare">
            <Card hover>
              <p className="font-mono text-sm text-[var(--lens-ranking)] font-semibold">
                Compare
              </p>
              <p className="text-xs text-[var(--text-secondary)] mt-1">
                Leaderboards, heatmaps, and analysis
              </p>
            </Card>
          </Link>
        ) : (
          <Card className="opacity-50 cursor-not-allowed">
            <p className="font-mono text-sm text-[var(--text-muted)] font-semibold">
              Compare
            </p>
            <p className="text-xs text-[var(--text-muted)] mt-1">
              Run benchmarks first
            </p>
          </Card>
        )}
      </div>

      {/* Recent activity — columns per spec: Run ID, Agent×Model, Scenarios, Pass Rate, Date */}
      {hasData && (
        <div>
          <h2 className="font-mono text-xs uppercase tracking-wider text-[var(--text-muted)] mb-3">
            Recent Activity
          </h2>
          <Card>
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--border)]">
                  {['Run ID', 'Agent × Model', 'Scenarios', 'Pass Rate', 'Date'].map((h) => (
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
                {recentRuns.map((run) => (
                  <tr key={run.id} className="border-b border-[var(--border)] last:border-0">
                    <td className="font-mono text-xs text-[var(--text-secondary)] py-2 px-3">
                      {run.id.slice(0, 8)}
                    </td>
                    <td className="text-xs text-[var(--text-primary)] py-2 px-3 max-w-[300px] truncate">
                      {run.agentModelPairs}
                    </td>
                    <td className="font-mono text-xs text-[var(--text-secondary)] py-2 px-3">
                      {run.scenarioCount}
                    </td>
                    <td className="font-mono text-xs text-[var(--text-primary)] py-2 px-3">
                      {run.passRate}
                    </td>
                    <td className="font-mono text-xs text-[var(--text-muted)] py-2 px-3">
                      {run.startedAt?.toLocaleDateString() ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      )}
    </div>
  );
}
