export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { ensureAppSchema } = await import('@/db/ensure-schema');
    await ensureAppSchema().catch((err) => {
      console.error('[Startup] Database schema migration failed:', err);
      throw err;
    });

    // Existing startup cleanup
    const { startupCleanup } = await import('@/lib/orchestrator/startup');
    await startupCleanup().catch((err) => {
      console.error('[startup] Cleanup failed:', err);
    });

    // Judge system — all imports dynamic under runtime guard
    const { startWorker } = await import('@/lib/judge/worker');
    const { recoverPendingEvaluations } = await import('@/lib/judge/service');
    const { startReclaimLoop } = await import('@/lib/judge/reclaim');
    const { startCleanupJob } = await import('@/lib/judge/cleanup');
    const { startMatviewRefreshWorker } = await import('@/lib/db/refresh-matviews');

    const consumerId = `worker-${process.pid}-${Date.now()}`;

    // Start judge worker (blocking loop — runs in background)
    startWorker(consumerId).catch((err) =>
      console.error('[Startup] Worker failed:', err)
    );

    // Start periodic jobs
    startReclaimLoop(consumerId);
    startCleanupJob();
    startMatviewRefreshWorker();

    // Recover incomplete evaluations from previous session
    recoverPendingEvaluations().catch((err) =>
      console.error('[Startup] Recovery failed:', err)
    );
  }
}
