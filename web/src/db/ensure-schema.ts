import path from 'path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { applyMaterializedViews } from './materialized-views';

/**
 * Applies pending Drizzle SQL migrations and (in production) rebuilds materialized views.
 * Docker and `next start` use NODE_ENV=production so views stay in sync with schema.
 */
export async function ensureAppSchema(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.warn('[Startup] DATABASE_URL not set; skipping DB migrations');
    return;
  }

  const migrationClient = postgres(url, { max: 1 });
  try {
    const db = drizzle(migrationClient);
    await migrate(db, { migrationsFolder: path.join(process.cwd(), 'drizzle') });
  } finally {
    await migrationClient.end({ timeout: 10 });
  }

  if (process.env.NODE_ENV !== 'production') {
    return;
  }

  const viewsClient = postgres(url);
  try {
    await applyMaterializedViews(viewsClient);
  } finally {
    await viewsClient.end({ timeout: 10 });
  }
}
