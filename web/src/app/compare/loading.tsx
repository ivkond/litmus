export default function CompareLoading() {
  return (
    <div className="space-y-4">
      <div className="h-6 w-32 animate-pulse rounded bg-[var(--bg-raised)]" />
      <div className="flex gap-2">
        {[1, 2, 3, 4].map((item) => (
          <div key={item} className="h-8 w-28 animate-pulse rounded bg-[var(--bg-raised)]" />
        ))}
      </div>
      <div className="flex gap-4">
        <div className="h-[400px] w-[280px] animate-pulse rounded-lg bg-[var(--bg-raised)]" />
        <div className="h-[400px] flex-1 animate-pulse rounded-lg bg-[var(--bg-raised)]" />
      </div>
    </div>
  );
}
