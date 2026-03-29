import { NextResponse } from 'next/server';
import { db } from '@/db';
import { judgeProviders } from '@/db/schema';
import { encrypt, decrypt } from '@/lib/judge/encryption';

function maskKey(encryptedKey: string): string {
  try {
    const plain = decrypt(encryptedKey);
    if (plain.length <= 8) return '••••';
    return '••••' + plain.slice(-4);
  } catch {
    return '••••';
  }
}

export async function GET() {
  const providers = await db
    .select()
    .from(judgeProviders)
    .orderBy(judgeProviders.priority);

  const masked = providers.map((p) => ({
    ...p,
    apiKey: maskKey(p.apiKey),
  }));

  return NextResponse.json(masked);
}

export async function POST(request: Request) {
  const body = await request.json();
  const { name, baseUrl, apiKey, model, enabled, priority } = body;

  if (!name || !baseUrl || !apiKey || !model) {
    return NextResponse.json(
      { error: 'name, baseUrl, apiKey, and model are required' },
      { status: 400 }
    );
  }

  if (!process.env.JUDGE_ENCRYPTION_KEY || process.env.JUDGE_ENCRYPTION_KEY.length !== 64) {
    return NextResponse.json(
      { error: 'JUDGE_ENCRYPTION_KEY is not configured. Set a 64-char hex string in environment.' },
      { status: 503 }
    );
  }

  const [provider] = await db
    .insert(judgeProviders)
    .values({
      name,
      baseUrl,
      apiKey: encrypt(apiKey),
      model,
      enabled: enabled ?? true,
      priority: priority ?? 0,
    })
    .returning();

  return NextResponse.json(
    { ...provider, apiKey: maskKey(provider.apiKey) },
    { status: 201 }
  );
}
