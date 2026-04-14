import { NextResponse } from 'next/server';
import { db } from '@/db';
import { judgeProviders } from '@/db/schema';
import { eq } from 'drizzle-orm';

export async function PUT(request: Request) {
  const body = await request.json();
  const { priorities } = body as { priorities: { id: string; priority: number }[] };

  if (!Array.isArray(priorities) || priorities.length === 0) {
    return NextResponse.json({ error: 'priorities array required' }, { status: 400 });
  }

  for (const { id, priority } of priorities) {
    await db
      .update(judgeProviders)
      .set({ priority })
      .where(eq(judgeProviders.id, id));
  }

  return NextResponse.json({ updated: priorities.length });
}
