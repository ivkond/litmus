'use client';

import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { ScenarioDetailResponse } from '@/lib/scenarios/types';

interface Props {
  data: ScenarioDetailResponse;
}

export function ScenarioSidebar({ data }: Props) {
  return (
    <div className="space-y-3">
      <Card>
        <h3 className="mb-2 font-mono text-xs uppercase tracking-wider text-[var(--text-muted)]">
          Metadata
        </h3>
        <div className="space-y-2 text-xs">
          <div className="flex justify-between">
            <span className="text-[var(--text-muted)]">Slug</span>
            <code className="text-[var(--text-secondary)]">{data.slug}</code>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--text-muted)]">Version</span>
            <span className="text-[var(--text-primary)]">{data.version ?? '—'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--text-muted)]">Language</span>
            {data.language ? <Badge variant="accent">{data.language}</Badge> : <span>—</span>}
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--text-muted)]">Max Score</span>
            <span className="text-[var(--text-primary)]">{data.maxScore ?? '—'}</span>
          </div>
          {data.tags && data.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1">
              {data.tags.map((tag) => (
                <Badge key={tag}>{tag}</Badge>
              ))}
            </div>
          )}
        </div>
      </Card>

      <Card>
        <h3 className="mb-2 font-mono text-xs uppercase tracking-wider text-[var(--text-muted)]">
          Performance
        </h3>
        <div className="space-y-2 text-xs">
          <div className="flex justify-between">
            <span className="text-[var(--text-muted)]">Total Runs</span>
            <span className="font-mono text-[var(--text-primary)]">{data.usage.totalRuns}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--text-muted)]">Avg Score</span>
            <span className="font-mono text-[var(--text-primary)]">
              {data.usage.avgScore != null ? `${data.usage.avgScore.toFixed(0)}%` : '—'}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--text-muted)]">Best</span>
            <span className="font-mono text-[var(--score-excellent)]">
              {data.usage.bestScore != null ? `${data.usage.bestScore.toFixed(0)}%` : '—'}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--text-muted)]">Worst</span>
            <span className="font-mono text-[var(--score-fail)]">
              {data.usage.worstScore != null ? `${data.usage.worstScore.toFixed(0)}%` : '—'}
            </span>
          </div>
        </div>
      </Card>

      <Card>
        <h3 className="mb-2 font-mono text-xs uppercase tracking-wider text-[var(--text-muted)]">
          Files ({data.files.length})
        </h3>
        <div className="space-y-1">
          {data.files.map((f) => (
            <div key={f.key} className="font-mono text-[0.65rem] text-[var(--text-secondary)] truncate">
              {f.key}
            </div>
          ))}
          {data.files.length === 0 && (
            <div className="text-xs text-[var(--text-muted)]">No files uploaded</div>
          )}
        </div>
      </Card>
    </div>
  );
}
