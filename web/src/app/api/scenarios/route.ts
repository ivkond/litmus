import { NextResponse } from 'next/server';
import { db } from '@/db';
import { scenarios } from '@/db/schema';

export async function GET() {
  const rows = await db.select().from(scenarios).orderBy(scenarios.slug);
  return NextResponse.json(rows);
}
