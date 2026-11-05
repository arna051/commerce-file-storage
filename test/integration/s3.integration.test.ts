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

  it('supports put, head, ranged reads, signed downloads, deletion, and multipart abort', async () => {
    const provider = new S3StorageProvider({ bucket, client, prefix: 'tenant/' });
    const bytes = Buffer.from('real minio range content');
    await expect(
      provider.put({
        key: 'direct.txt',
        body: Readable.from(bytes),
        contentType: 'text/plain',
        contentLength: bytes.length,
      }),
    ).resolves.toMatchObject({ key: 'direct.txt', size: bytes.length });
    expect(await provider.head('direct.txt')).toMatchObject({ size: bytes.length });
    const range = await provider.getStream('direct.txt', { start: 5, end: 9 });
    const chunks: Buffer[] = [];
    for await (const chunk of range) chunks.push(Buffer.from(chunk as Uint8Array));
    expect(Buffer.concat(chunks).toString()).toBe('minio');
    await expect(
      provider.signDownload({ key: 'direct.txt', expiresInSeconds: 60, filename: 'my file.txt' }),
    ).resolves.toContain('X-Amz-Signature=');
    const multipart = await provider.createMultipart({
      key: 'aborted.bin',
      contentType: 'application/octet-stream',
    });
    await provider.abortMultipart({ key: 'aborted.bin', uploadId: multipart.uploadId });
    await provider.delete('direct.txt');
    expect(await provider.head('direct.txt')).toBeNull();
  });
});
