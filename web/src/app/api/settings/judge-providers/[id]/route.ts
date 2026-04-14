import { NextResponse } from 'next/server';
import { db } from '@/db';
import { judgeProviders } from '@/db/schema';
import { encrypt, maskKey } from '@/lib/judge/encryption';
import { eq } from 'drizzle-orm';

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();

  if ('apiKey' in body && body.apiKey === '') {
    return NextResponse.json(
      { error: 'apiKey cannot be empty string. Omit field to keep current key.' },
      { status: 400 }
    );
  }

  const updates: Record<string, unknown> = {};
  for (const field of ['name', 'baseUrl', 'model', 'enabled', 'priority'] as const) {
    if (field in body) updates[field] = body[field];
  }
  if ('apiKey' in body && body.apiKey) {
    updates.apiKey = encrypt(body.apiKey);
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
  }

  const [updated] = await db
    .update(judgeProviders)
    .set(updates)
    .where(eq(judgeProviders.id, id))
    .returning();

  if (!updated) {
    return NextResponse.json({ error: 'Provider not found' }, { status: 404 });
  }

  return NextResponse.json({ ...updated, apiKey: maskKey(updated.apiKey) });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const [deleted] = await db
    .delete(judgeProviders)
    .where(eq(judgeProviders.id, id))
    .returning();

  if (!deleted) {
    return NextResponse.json({ error: 'Provider not found' }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
