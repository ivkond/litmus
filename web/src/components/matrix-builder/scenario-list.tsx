'use client';

interface Scenario { id: string; slug: string; name: string; language: string | null }

interface ScenarioListProps {
  scenarios: Scenario[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onSelectAll: () => void;
}

export function ScenarioList({ scenarios, selected, onToggle, onSelectAll }: ScenarioListProps) {
  const allSelected = scenarios.length > 0 && scenarios.every((s) => selected.has(s.id));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="font-mono text-xs text-[var(--text-muted)]">
          {selected.size} of {scenarios.length} selected
        </span>
        <button onClick={onSelectAll} className="text-xs text-[var(--accent)] hover:underline">
          {allSelected ? 'Deselect all' : 'Select all'}
        </button>
      </div>
      <div className="space-y-1">
        {scenarios.map((s) => (
          <label key={s.id} className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-[var(--bg-raised)] cursor-pointer transition-colors">
            <input
              type="checkbox"
              checked={selected.has(s.id)}
              onChange={() => onToggle(s.id)}
              className="accent-[var(--accent)]"
            />
            <span className="font-mono text-sm text-[var(--text-secondary)]">{s.slug}</span>
            {s.language && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--bg-raised)] text-[var(--text-muted)]">
                {s.language}
              </span>
            )}
          </label>
        ))}
      </div>
    </div>
  );
}
