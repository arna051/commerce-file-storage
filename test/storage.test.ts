import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { MongooseAclAuthorizer, createFileStorage } from '../src/index.js';
import { MemoryBlobProvider, MemoryMetadataStore } from '../src/testing/index.js';

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3, 4]);
function setup(options: Record<string, unknown> = {}) {
  const provider = new MemoryBlobProvider();
  const metadata = new MemoryMetadataStore();
  const storage = createFileStorage({
    provider,
    metadata,
    idGenerator: (() => {
      let n = 0;
      return () => `id-${++n}`;
    })(),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...options,
  });
  return { provider, metadata, storage };
}

describe('FileStorage', () => {
  it('streams, identifies, hashes, and stores a file without buffering API input', async () => {
    const { storage } = setup();
    const file = await storage.upload({
      namespace: 'business/1',
      stream: Readable.from(jpeg),
      filename: '../unsafe.jpg',
      contentType: 'application/octet-stream',
      contentLength: jpeg.length,
      access: { mode: 'public', policyVersion: 1 },
    });
    expect(file.contentType).toBe('image/jpeg');
    expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(file.objectKey).not.toContain('unsafe');
    expect(await storage.openDownload(file.id)).toBeInstanceOf(Readable);
  });
  it('rejects a mismatched content length and marks metadata failed', async () => {
    const { storage, metadata } = setup();
    await expect(
      storage.upload({
        namespace: 'business/1',
        stream: Readable.from(jpeg),
        contentType: 'image/jpeg',
        contentLength: 100,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect([...metadata.files.values()][0]?.lifecycleStatus).toBe('failed');
  });
  it('enforces detected MIME allowlists and rejects SVG by default', async () => {
    const { storage } = setup({ allowedContentTypes: ['image/*'] });
    const pdf = Buffer.from('%PDF-1.7 body');
    await expect(
      storage.upload({
        namespace: 'business/1',
        stream: Readable.from(pdf),
        contentType: 'image/jpeg',
        contentLength: pdf.length,
      }),
    ).rejects.toMatchObject({ code: 'MIME_NOT_ALLOWED' });
    const svg = Buffer.from('<svg><script>alert(1)</script></svg>');
    await expect(
      storage.upload({
        namespace: 'business/1',
        stream: Readable.from(svg),
        contentType: 'image/svg+xml',
        contentLength: svg.length,
      }),
    ).rejects.toMatchObject({ code: 'MIME_NOT_ALLOWED' });
  });
  it('continues with an explicit skipped status when scanner is unavailable', async () => {
    const { storage } = setup({
      scanner: { name: 'broken', scan: vi.fn().mockRejectedValue(new Error('offline')) },
    });
    const file = await storage.upload({
      namespace: 'business/1',
      stream: Readable.from(jpeg),
      contentType: 'image/jpeg',
      contentLength: jpeg.length,
    });
    expect(file.scanStatus).toBe('skipped-unavailable');
    expect(file.lifecycleStatus).toBe('available');
  });
  it('creates and resumes idempotent multipart sessions', async () => {
    const { storage } = setup();
    const input = {
      namespace: 'business/1',
      contentType: 'application/pdf',
      contentLength: 6 * 1024 * 1024,
      idempotencyKey: 'request-1234',
    };
    const first = await storage.createMultipartUpload(input);
    const second = await storage.createMultipartUpload(input);
    expect(second.id).toBe(first.id);
  });
  it('enforces public and group grants', async () => {
    const { metadata } = setup();
    const authorizer = new MongooseAclAuthorizer(metadata);
    const secured = createFileStorage({
      provider: new MemoryBlobProvider(),
      metadata,
      authorizer,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const file = await secured.upload({
      namespace: 'business/1',
      stream: Readable.from(jpeg),
      contentType: 'image/jpeg',
      contentLength: jpeg.length,
      access: { mode: 'restricted', owner: { type: 'user', id: 'owner' }, policyVersion: 1 },
    });
    await expect(secured.getFile(file.id, { type: 'user', id: 'stranger' })).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
    });
    expect((await secured.getFile(file.id, { type: 'user', id: 'owner' })).id).toBe(file.id);
  });
  it('keeps a file unavailable until scanning succeeds', async () => {
    let finish: ((value: { status: 'clean' }) => void) | undefined;
    const scanner = {
      name: 'delayed',
      scan: vi.fn(() => new Promise<{ status: 'clean' }>((resolve) => (finish = resolve))),
    };
    const { storage, metadata } = setup({ scanner });
    const uploading = storage.upload({
      namespace: 'business/1',
      stream: Readable.from(jpeg),
      contentType: 'image/jpeg',
      contentLength: jpeg.length,
      access: { mode: 'public', policyVersion: 1 },
    });
    await vi.waitFor(() => expect(scanner.scan).toHaveBeenCalledOnce());
    expect(metadata.files.get('id-1')?.lifecycleStatus).toBe('quarantined');
    await expect(storage.openDownload('id-1')).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    finish?.({ status: 'clean' });
    expect((await uploading).lifecycleStatus).toBe('available');
  });
  it('quarantines infected files and removes their object', async () => {
    const { storage, metadata, provider } = setup({
      scanner: { name: 'infected', scan: vi.fn().mockResolvedValue({ status: 'infected' }) },
    });
    await expect(
      storage.upload({
        namespace: 'business/1',
        stream: Readable.from(jpeg),
        contentType: 'image/jpeg',
        contentLength: jpeg.length,
      }),
    ).rejects.toMatchObject({ code: 'SCAN_INFECTED' });
    expect(metadata.files.get('id-1')).toMatchObject({
      lifecycleStatus: 'quarantined',
      scanStatus: 'infected',
    });
    expect(provider.objects.size).toBe(0);
  });
  it('scopes multipart idempotency keys to a namespace and rejects conflicting reuse', async () => {
    const { storage } = setup();
    const base = {
      contentType: 'application/pdf',
      contentLength: 1024,
      idempotencyKey: 'same-request',
    };
    const first = await storage.createMultipartUpload({ ...base, namespace: 'business/1' });
    const second = await storage.createMultipartUpload({ ...base, namespace: 'business/2' });
    expect(second.id).not.toBe(first.id);
    await expect(
      storage.createMultipartUpload({
        ...base,
        namespace: 'business/1',
        contentLength: 2048,
      }),
    ).rejects.toMatchObject({ code: 'UPLOAD_STATE_CONFLICT' });
  });
  it('uploads, resumes, and completes multipart content with a verified hash', async () => {
    const { storage } = setup();
    const bytes = Buffer.from('%PDF multipart body');
    const session = await storage.createMultipartUpload({
      namespace: 'business/1',
      contentType: 'application/pdf',
      contentLength: bytes.length,
      idempotencyKey: 'multipart-complete',
    });
    await storage.uploadPart(session.id, 1, Readable.from(bytes), bytes.length);
    expect((await storage.resumeMultipartUpload(session.id)).parts).toHaveLength(1);
    const file = await storage.completeMultipartUpload(session.id);
    expect(file).toMatchObject({
      lifecycleStatus: 'available',
      contentType: 'application/pdf',
      size: bytes.length,
    });
    expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect((await storage.completeMultipartUpload(session.id)).id).toBe(file.id);
  });
  it('aborts multipart uploads idempotently and rejects invalid parts', async () => {
    const { storage, provider } = setup();
    const session = await storage.createMultipartUpload({
      namespace: 'business/1',
      contentType: 'application/pdf',
      contentLength: 10,
      idempotencyKey: 'multipart-abort',
    });
    await expect(storage.uploadPart(session.id, 0, Readable.from('x'), 1)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await storage.abortMultipartUpload(session.id);
    await storage.abortMultipartUpload(session.id);
    expect(provider.multipart.size).toBe(0);
  });
  it('soft deletes, restores, and purges retained objects', async () => {
    const { storage, provider } = setup();
    const file = await storage.upload({
      namespace: 'business/1',
      stream: Readable.from(jpeg),
      contentType: 'image/jpeg',
      contentLength: jpeg.length,
      access: { mode: 'restricted', owner: { type: 'user', id: 'owner' }, policyVersion: 1 },
    });
    const owner = { type: 'user' as const, id: 'owner' };
    expect((await storage.softDelete(file.id, owner)).lifecycleStatus).toBe('soft-deleted');
    expect((await storage.restore(file.id, owner)).lifecycleStatus).toBe('available');
    await storage.softDelete(file.id, owner);
    const result = await storage.purgeDeletedFiles({ before: new Date(Date.now() + 1000) });
    expect(result).toMatchObject({ purged: 1, failed: 0 });
    expect(provider.objects.size).toBe(0);
  });
  it('cleans expired multipart sessions', async () => {
    let now = new Date('2026-01-01T00:00:00Z');
    const { storage, metadata, provider } = setup({
      now: () => now,
      uploadSessionTtlMs: 1000,
    });
    const session = await storage.createMultipartUpload({
      namespace: 'business/1',
      contentType: 'application/pdf',
      contentLength: 10,
      idempotencyKey: 'multipart-expired',
    });
    now = new Date(now.getTime() + 2000);
    expect(await storage.cleanupExpiredUploads()).toMatchObject({ cleaned: 1, failed: 0 });
    expect((await metadata.getUpload(session.id))?.status).toBe('expired');
    expect(provider.multipart.size).toBe(0);
  });
  it('grants and revokes group access', async () => {
    const provider = new MemoryBlobProvider();
    const metadata = new MemoryMetadataStore();
    const storage = createFileStorage({
      provider,
      metadata,
      authorizer: new MongooseAclAuthorizer(metadata),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const owner = { type: 'user' as const, id: 'owner' };
    const file = await storage.upload({
      namespace: 'business/1',
      stream: Readable.from(jpeg),
      contentType: 'image/jpeg',
      contentLength: jpeg.length,
      access: { mode: 'restricted', owner, policyVersion: 1 },
    });
    await storage.grantAccess(file.id, owner, {
      principal: { type: 'group', id: 'catalog' },
      actions: ['read'],
    });
    const member = { type: 'user' as const, id: 'member', groups: ['catalog'] };
    await expect(storage.getFile(file.id, member)).resolves.toMatchObject({ id: file.id });
    await storage.revokeAccess(file.id, owner, { type: 'group', id: 'catalog' });
    await expect(storage.getFile(file.id, member)).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
    });
  });
});
