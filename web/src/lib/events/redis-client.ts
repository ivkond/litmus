import Redis from 'ioredis';
import { env } from '@/lib/env';

let publisherClient: Redis | null = null;
let subscriberClient: Redis | null = null;
let consumerClient: Redis | null = null;

function createClient(name: string): Redis {
  const client = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
    connectionName: `litmus-${name}`,
  });
  client.on('error', (err) => {
    console.error(`[Redis:${name}] Error:`, err.message);
  });
  return client;
}

/** Publisher client — for XADD and PUBLISH */
export function getPublisher(): Redis {
  if (!publisherClient) {
    publisherClient = createClient('publisher');
  }
  return publisherClient;
}

/** Subscriber client — dedicated to Pub/Sub channel subscriptions (SSE) */
export function getSubscriber(): Redis {
  if (!subscriberClient) {
    subscriberClient = createClient('subscriber');
  }
  return subscriberClient;
}

/** Consumer client — for XREADGROUP in JudgeWorker (blocking read) */
export function getConsumer(): Redis {
  if (!consumerClient) {
    consumerClient = createClient('consumer');
  }
  return consumerClient;
}

/** Graceful shutdown — call on process exit */
export async function closeAllClients(): Promise<void> {
  const clients = [publisherClient, subscriberClient, consumerClient];
  await Promise.allSettled(
    clients.filter(Boolean).map((c) => c!.quit())
  );
  publisherClient = null;
  subscriberClient = null;
  consumerClient = null;
}
