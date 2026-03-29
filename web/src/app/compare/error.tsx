'use client';

export default function CompareError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-16">
      <p className="text-sm text-[var(--score-fail)]">
        Failed to load compare data: {error.message}
      </p>
      <button
        onClick={reset}
        className="rounded-md border border-[var(--border)] bg-[var(--bg-raised)] px-4 py-2 text-sm font-semibold text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
      >
        Retry
      </button>
    </div>
  );
}
