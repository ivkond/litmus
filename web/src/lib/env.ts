import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  S3_ENDPOINT: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_REGION: z.string().default('garage'),
  DOCKER_HOST: z.string().default('tcp://localhost:2375'),
});

export const env = envSchema.parse(process.env);
