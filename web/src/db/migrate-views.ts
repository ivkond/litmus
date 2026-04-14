import 'dotenv/config';
import postgres from 'postgres';
import { applyMaterializedViews } from './materialized-views';

const client = postgres(process.env.DATABASE_URL!);

async function main() {
  console.log('Creating materialized views...');
  await applyMaterializedViews(client);
  console.log('Materialized views created successfully.');
  await client.end();
}

main().catch((err) => {
  console.error('Failed to create materialized views:', err);
  process.exit(1);
});
