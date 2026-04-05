import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { agentSecrets } from '@/db/schema';
import { encrypt, decrypt, hasEncryptionKey } from '@/lib/encryption';

/**
 * Phase 2 migration: re-encrypt old plain-string api_key secrets into keyed JSON format.
 *
 * Old format: acpMethodId = "CURSOR_API_KEY", encryptedValue = encrypt("sk-abc123")
 * New format: acpMethodId = "CURSOR_API_KEY", encryptedValue = encrypt('{"CURSOR_API_KEY":"sk-abc123"}')
 *
 * Runs at app startup. Idempotent — already-migrated rows are skipped.
 */
export async function migrateSecretsToKeyedJson(): Promise<number> {
  if (!hasEncryptionKey()) {
    console.warn('[migrate-secrets] No encryption key — skipping Phase 2 migration');
    return 0;
  }

  const rows = await db.select().from(agentSecrets);
  let migrated = 0;

  for (const row of rows) {
    if (row.authType !== 'api_key') continue;

    try {
      const decrypted = decrypt(row.encryptedValue);

      try {
        const parsed = JSON.parse(decrypted);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          continue; // Already migrated
        }
      } catch {
        // Not JSON — needs migration
      }

      const keyedJson = JSON.stringify({ [row.acpMethodId]: decrypted });
      const reEncrypted = encrypt(keyedJson);

      await db
        .update(agentSecrets)
        .set({ encryptedValue: reEncrypted, updatedAt: new Date() })
        .where(eq(agentSecrets.id, row.id));

      migrated++;
    } catch (e) {
      console.error(`[migrate-secrets] Failed to migrate secret ${row.id}:`, e);
    }
  }

  if (migrated > 0) {
    console.log(`[migrate-secrets] Phase 2: migrated ${migrated} secrets to keyed JSON format`);
  }

  return migrated;
}
