import { subscribeAll } from '@/lib/events/redis-bus';
import type { RedisEvent } from '@/lib/events/redis-bus';

export async function GET() {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const unsubscribe = subscribeAll((event: RedisEvent) => {
        if (
          event.type === 'judge:started' ||
          event.type === 'judge:verdict' ||
          event.type === 'judge:completed'
        ) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
          );
        }
      });

      const checkClosed = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
        } catch {
          unsubscribe();
          clearInterval(checkClosed);
        }
      }, 15000);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
