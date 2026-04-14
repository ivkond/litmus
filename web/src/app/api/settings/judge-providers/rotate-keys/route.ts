import { NextResponse } from 'next/server';
import { db } from '@/db';
import { judgeProviders } from '@/db/schema';
import { encrypt, decrypt } from '@/lib/judge/encryption';
import { eq } from 'drizzle-orm';

export async function POST() {
  const providers = await db.select().from(judgeProviders);
  let rotated = 0;

  for (const provider of providers) {
    try {
      const plainKey = decrypt(provider.apiKey);
      const newEncrypted = encrypt(plainKey);
      await db
        .update(judgeProviders)
        .set({ apiKey: newEncrypted })
        .where(eq(judgeProviders.id, provider.id));
      rotated++;
    } catch (err) {
      console.error(`Failed to rotate key for provider ${provider.id}:`, err);
    }
  }

  return NextResponse.json({ rotated, total: providers.length });
}
