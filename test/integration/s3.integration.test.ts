import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { beforeAll, describe, expect, it } from 'vitest';
import { createFileStorage } from '../../src/index.js';
import { S3StorageProvider } from '../../src/s3/index.js';
import { MemoryMetadataStore } from '../../src/testing/index.js';

const enabled = process.env.RUN_INTEGRATION === '1' && Boolean(process.env.S3_ENDPOINT);
describe.skipIf(!enabled)('S3StorageProvider integration', () => {
  const endpoint = process.env.S3_ENDPOINT ?? 'http://127.0.0.1:9000';
  const bucket = `commerce-file-storage-${process.pid}-${Date.now()}`;
  const credentials = {
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'commerce_admin',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'development-password-change-me',
  };
  const client = new S3Client({ endpoint, region: 'us-east-1', forcePathStyle: true, credentials });
  beforeAll(async () => {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  });
  it('completes multipart and records a real SHA-256 rather than an ETag', async () => {
    const metadata = new MemoryMetadataStore();
    const storage = createFileStorage({
      provider: new S3StorageProvider({ bucket, client }),
      metadata,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    const bytes = Buffer.alloc(1024 * 1024, 7);
    const session = await storage.createMultipartUpload({
      namespace: 'business/integration',
      contentType: 'application/octet-stream',
      contentLength: bytes.length,
      idempotencyKey: `integration-${Date.now()}`,
    });
    await storage.uploadPart(session.id, 1, Readable.from(bytes), bytes.length);
    const file = await storage.completeMultipartUpload(session.id);
    expect(file.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(file.sha256).toHaveLength(64);
  });
});
