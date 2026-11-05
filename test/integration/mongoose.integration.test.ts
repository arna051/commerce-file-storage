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
  });
});
