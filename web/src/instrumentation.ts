export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startupCleanup } = await import('@/lib/orchestrator/startup');
    await startupCleanup().catch((err) => {
      console.error('[startup] Cleanup failed:', err);
    });
  }
}
