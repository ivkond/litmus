import { NextResponse } from 'next/server';
import { db } from '@/db';
import { judgeProviders } from '@/db/schema';
import { decrypt } from '@/lib/judge/encryption';
import { eq } from 'drizzle-orm';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const [provider] = await db
    .select()
    .from(judgeProviders)
    .where(eq(judgeProviders.id, id));

  if (!provider) {
    return NextResponse.json({ error: 'Provider not found' }, { status: 404 });
  }

  const start = Date.now();
  try {
    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${decrypt(provider.apiKey)}`,
      },
      body: JSON.stringify({
        model: provider.model,
        messages: [{ role: 'user', content: 'Say "ok"' }],
        max_tokens: 5,
      }),
      signal: AbortSignal.timeout(15000),
    });

    const latencyMs = Date.now() - start;

    if (!response.ok) {
      return NextResponse.json({
        success: false,
        latencyMs,
        error: `HTTP ${response.status}: ${await response.text()}`,
      });
    }

    return NextResponse.json({ success: true, latencyMs });
  } catch (err) {
    return NextResponse.json({
      success: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
}
