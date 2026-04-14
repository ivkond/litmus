import { z } from 'zod';

const envShape = {
  DATABASE_URL: z.string().min(1),
  S3_ENDPOINT: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_REGION: z.string().default('garage'),
  DOCKER_HOST: z.string().default('tcp://localhost:2375'),
  WORK_ROOT: z.string().default('./work'),
  AGENTS_HOST_DIR: z.string().optional(),
  WORK_HOST_DIR: z.string().optional(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  JUDGE_ENCRYPTION_KEY: z.string().length(64).optional(), // 32 bytes hex, legacy — prefer LITMUS_ENCRYPTION_KEY
  LITMUS_ENCRYPTION_KEY: z.string().length(64).optional(), // 32 bytes hex, used for agent secrets & judge keys
} as const;

const envSchema = z.object(envShape);
type Env = z.infer<typeof envSchema>;
type EnvKey = keyof typeof envShape;

function readEnvValue<K extends EnvKey>(key: K): Env[K] {
  const parsed = envShape[key].safeParse(process.env[key]);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? 'Invalid value';
    throw new Error(`[env] ${String(key)}: ${message}`);
  }
  return parsed.data as Env[K];
}

export const env: Env = new Proxy({} as Env, {
  get(_target, prop: string | symbol): unknown {
    if (typeof prop !== 'string') return undefined;
    if (!(prop in envShape)) return undefined;
    return readEnvValue(prop as EnvKey);
  },
});
