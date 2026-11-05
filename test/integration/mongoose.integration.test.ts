import { Readable } from 'node:stream';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFileStorage } from '../../src/index.js';
import { MongooseMetadataStore } from '../../src/mongoose/index.js';
import { MemoryBlobProvider } from '../../src/testing/index.js';

const enabled = process.env.RUN_INTEGRATION === '1';
describe.skipIf(!enabled)('MongooseMetadataStore integration', () => {
  const dbName = `commerce_file_storage_test_${process.pid}_${Date.now()}`;
  const connection = mongoose.createConnection(
    process.env.MONGODB_URI ?? `mongodb://127.0.0.1:27017/${dbName}`,
    { dbName },
  );
  let metadata: MongooseMetadataStore;
  beforeAll(async () => {
    await connection.asPromise();
    metadata = new MongooseMetadataStore({ connection, collectionPrefix: 'integration' });
    await metadata.ensureIndexes();
  });
  afterAll(async () => {
    await connection.dropDatabase();
    await connection.close();
  });
  it('persists the pending-to-available upload lifecycle', async () => {
    const storage = createFileStorage({
      provider: new MemoryBlobProvider(),
      metadata,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]);
    const file = await storage.upload({
      namespace: 'business/integration',
      stream: Readable.from(bytes),
      contentType: 'image/jpeg',
      contentLength: bytes.length,
    });
    expect(file.lifecycleStatus).toBe('available');
    expect((await metadata.getFile(file.id))?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await metadata.findFiles({ namespace: 'business/integration', limit: 10 })).toHaveLength(
      1,
    );
    await expect(
      metadata.updateFile(file.id, new Date(0), { lifecycleStatus: 'failed' }),
    ).rejects.toMatchObject({ code: 'METADATA_ERROR', retryable: true });

    const grant = await metadata.putGrant({
      id: 'grant-1',
      fileId: file.id,
      principal: { type: 'group', id: 'catalog' },
      actions: ['read'],
      createdAt: new Date(),
    });
    expect(grant.principal.id).toBe('catalog');
    expect(await metadata.listGrants(file.id)).toHaveLength(1);
    await metadata.revokeGrant(file.id, grant.principal);
    expect(await metadata.listGrants(file.id)).toHaveLength(0);
  });

  it('collapses concurrent multipart idempotency races to one session', async () => {
    const provider = new MemoryBlobProvider();
    const storage = createFileStorage({
      provider,
      metadata,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    const input = {
      namespace: 'business/race',
      contentType: 'application/pdf',
      contentLength: 100,
      idempotencyKey: `race-${Date.now()}`,
    };
    const sessions = await Promise.all(
      Array.from({ length: 8 }, () => storage.createMultipartUpload(input)),
    );
    expect(new Set(sessions.map((session) => session.id)).size).toBe(1);
    expect(provider.multipart.size).toBe(1);
    await storage.uploadPart(sessions[0]!.id, 1, Readable.from('%PDF part'), 9);
    expect((await metadata.getUpload(sessions[0]!.id))?.status).toBe('uploading');
    expect((await storage.resumeMultipartUpload(sessions[0]!.id)).parts).toHaveLength(1);
    expect(
      await metadata.listExpiredUploads(new Date(Date.now() + 2 * 24 * 60 * 60 * 1000), 10),
    ).toHaveLength(1);
  });
});
