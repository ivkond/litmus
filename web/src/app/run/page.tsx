import { Suspense } from 'react';
import { RunBuilder } from './run-builder';

export default function RunPage() {
  return (
    <Suspense
      fallback={
        <div className="space-y-4">
          <h1 className="font-mono text-lg text-[var(--text-primary)]">New Benchmark Run</h1>
          <p className="text-sm text-[var(--text-muted)]">Loading...</p>
        </div>
      }
    >
      <RunBuilder />
    </Suspense>
  );
}
