'use client';

import { useRouter } from 'next/navigation';
import type { LensType } from '@/lib/compare/types';

interface Props {
  lens: LensType;
  anchors: Array<{ id: string; name: string }>;
  selectedId?: string;
}

export function AnchorDropdown({ lens, anchors, selectedId }: Props) {
  const router = useRouter();
  const paramKey = lens === 'agent-x-models' ? 'agentId' : 'modelId';
  const label = lens === 'agent-x-models' ? 'Agent' : 'Model';

  return (
    <div className="mb-4 flex items-center gap-2">
      <label className="text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)]">
        {label}
      </label>
      <select
        value={selectedId ?? ''}
        onChange={(event) => router.push(`/compare?lens=${lens}&${paramKey}=${event.target.value}`)}
        className="rounded border border-[var(--border)] bg-[var(--bg-raised)] px-2 py-1 text-sm font-mono text-[var(--text-primary)]"
      >
        {anchors.map((anchor) => (
          <option key={anchor.id} value={anchor.id}>
            {anchor.name}
          </option>
        ))}
      </select>
    </div>
  );
}
