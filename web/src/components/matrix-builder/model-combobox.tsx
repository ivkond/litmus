'use client';

import { useState, useRef, useEffect, useCallback } from 'react';

interface ModelOption {
  dbId: string;
  name: string;
  provider?: string;
}

interface Props {
  models: ModelOption[];
  selected: Set<string>;
  onToggle: (modelDbId: string) => void;
}

export function ModelCombobox({ models, selected, onToggle }: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const lowerQuery = query.toLowerCase();
  const filtered = models.filter(
    (m) =>
      m.name.toLowerCase().includes(lowerQuery) ||
      (m.provider ?? '').toLowerCase().includes(lowerQuery) ||
      m.dbId.toLowerCase().includes(lowerQuery),
  );

  // Group by provider
  const grouped = new Map<string, ModelOption[]>();
  for (const m of filtered) {
    const key = m.provider || 'Other';
    const arr = grouped.get(key) ?? [];
    arr.push(m);
    grouped.set(key, arr);
  }

  const selectedModels = models.filter((m) => selected.has(m.dbId));

  const handleRemove = useCallback(
    (dbId: string) => {
      onToggle(dbId);
    },
    [onToggle],
  );

  return (
    <div ref={containerRef} className="relative">
      {/* Selected chips */}
      {selectedModels.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {selectedModels.map((m) => (
            <span
              key={m.dbId}
              className="inline-flex items-center gap-1 font-mono text-xs px-2 py-0.5 rounded-full
                bg-[var(--accent-dim)] text-[var(--accent)] border border-[var(--accent)]"
            >
              {m.name}
              <button
                onClick={() => handleRemove(m.dbId)}
                className="hover:text-[var(--text-primary)] transition-colors leading-none"
                aria-label={`Remove ${m.name}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Search input */}
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => setOpen(true)}
        placeholder={`Search ${models.length} models…`}
        className="w-full px-3 py-1.5 rounded-md text-xs font-mono
          bg-[var(--bg-base)] border border-[var(--border)]
          text-[var(--text-primary)] placeholder:text-[var(--text-muted)]
          focus:outline-none focus:border-[var(--accent)]"
      />

      {/* Dropdown */}
      {open && (
        <div
          className="absolute z-50 mt-1 w-full max-h-64 overflow-y-auto rounded-md border
            border-[var(--border)] bg-[var(--bg-raised)] shadow-lg"
        >
          {filtered.length === 0 && (
            <div className="px-3 py-2 text-xs text-[var(--text-muted)] font-mono">
              No models match "{query}"
            </div>
          )}
          {Array.from(grouped.entries()).map(([provider, providerModels]) => (
            <div key={provider}>
              <div className="px-3 py-1 text-[10px] font-mono uppercase tracking-wider text-[var(--text-muted)] bg-[var(--bg-overlay)] sticky top-0">
                {provider}
              </div>
              {providerModels.map((m) => {
                const isSelected = selected.has(m.dbId);
                return (
                  <button
                    key={m.dbId}
                    onClick={() => onToggle(m.dbId)}
                    className={`w-full text-left px-3 py-1.5 text-xs font-mono flex items-center gap-2
                      hover:bg-[var(--bg-hover)] transition-colors ${
                        isSelected ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]'
                      }`}
                  >
                    <span className={`w-3.5 h-3.5 rounded border flex-shrink-0 flex items-center justify-center ${
                      isSelected
                        ? 'bg-[var(--accent)] border-[var(--accent)]'
                        : 'border-[var(--border)]'
                    }`}>
                      {isSelected && (
                        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                          <path d="M2 5L4 7L8 3" stroke="var(--bg-base)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </span>
                    {m.name}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
