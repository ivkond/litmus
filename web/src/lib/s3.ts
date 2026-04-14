import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT!,
  region: process.env.S3_REGION || 'garage',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY!,
    secretAccessKey: process.env.S3_SECRET_KEY!,
  },
  forcePathStyle: true,
});

export const BUCKETS = {
  scenarios: 'litmus-scenarios',
  artifacts: 'litmus-artifacts',
  packs: 'litmus-packs',
} as const;

export async function uploadFile(
  bucket: string,
  key: string,
  body: Buffer | string,
  contentType = 'application/octet-stream',
): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
  }));
}

export async function downloadFile(
  bucket: string,
  key: string,
): Promise<Buffer> {
  const response = await s3.send(new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  }));
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function listFiles(
  bucket: string,
  prefix: string,
): Promise<string[]> {
  const response = await s3.send(new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: prefix,
  }));
  return (response.Contents ?? []).map((obj) => obj.Key!);
}

export async function deleteFile(
  bucket: string,
  key: string,
): Promise<void> {
  await s3.send(new DeleteObjectCommand({
    Bucket: bucket,
    Key: key,
  }));
}

export { s3 };
