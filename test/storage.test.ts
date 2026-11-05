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
      retention: { mode: 'temporary', expiresAt: new Date('2030-01-01T00:00:00.000Z') },
    });
    expect(session.retention).toEqual({
      mode: 'temporary',
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    });
    await storage.uploadPart(session.id, 1, Readable.from(bytes), bytes.length);
    expect((await storage.resumeMultipartUpload(session.id)).parts).toHaveLength(1);
    const file = await storage.completeMultipartUpload(session.id);
    expect(file).toMatchObject({
      lifecycleStatus: 'available',
      contentType: 'application/pdf',
      size: bytes.length,
      retention: { mode: 'temporary' },
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

  it('creates signed downloads with bounded expiry and the original filename', async () => {
    const { storage, provider } = setup({ signedUrlMaxExpirySeconds: 600 });
    const sign = vi.spyOn(provider, 'signDownload');
    const file = await storage.upload({
      namespace: 'business/1',
      stream: Readable.from(jpeg),
      filename: 'product photo.jpg',
      contentType: 'image/jpeg',
      contentLength: jpeg.length,
    });
    await expect(storage.createSignedDownload(file.id, null, 3600)).resolves.toContain(
      'expires=600',
    );
    expect(sign).toHaveBeenCalledWith({
      key: file.objectKey,
      expiresInSeconds: 600,
      filename: 'product photo.jpg',
    });
  });

  it('rejects signed downloads when unsupported or the file is unavailable', async () => {
    const first = setup();
    const file = await first.storage.upload({
      namespace: 'business/1',
      stream: Readable.from(jpeg),
      contentType: 'image/jpeg',
      contentLength: jpeg.length,
    });
    Object.defineProperty(first.provider, 'signDownload', { value: undefined });
    await expect(first.storage.createSignedDownload(file.id, null)).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
    });
    const owner = { type: 'user' as const, id: 'owner' };
    const second = setup();
    const deleted = await second.storage.upload({
      namespace: 'business/1',
      stream: Readable.from(jpeg),
      contentType: 'image/jpeg',
      contentLength: jpeg.length,
      access: { mode: 'restricted', owner, policyVersion: 1 },
    });
    await second.storage.softDelete(deleted.id, owner);
    await expect(second.storage.createSignedDownload(deleted.id, owner)).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
    });
  });

  it('enforces maximum size before and while streaming and removes partial bytes', async () => {
    const { storage, metadata, provider } = setup({ maxFileSize: 6 });
    await expect(
      storage.upload({
        namespace: 'business/1',
        stream: Readable.from(jpeg),
        contentType: 'image/jpeg',
        contentLength: jpeg.length,
      }),
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    await expect(
      storage.upload({
        namespace: 'business/1',
        stream: Readable.from(jpeg),
        contentType: 'image/jpeg',
        contentLength: 6,
      }),
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    expect(provider.objects.size).toBe(0);
    expect([...metadata.files.values()].at(-1)?.lifecycleStatus).toBe('failed');
  });

  it.each([
    ['quarantine', 'quarantined'],
    ['reject', 'failed'],
  ] as const)('applies the %s scanner-unavailable policy', async (policy, lifecycleStatus) => {
    const { storage, metadata, provider } = setup({
      scannerUnavailablePolicy: policy,
      scanner: { name: 'offline', scan: vi.fn().mockRejectedValue(new Error('offline')) },
    });
    const operation = storage.upload({
      namespace: 'business/1',
      stream: Readable.from(jpeg),
      contentType: 'image/jpeg',
      contentLength: jpeg.length,
    });
    if (policy === 'reject')
      await expect(operation).rejects.toMatchObject({ code: 'SCAN_UNAVAILABLE' });
    else await expect(operation).resolves.toMatchObject({ lifecycleStatus });
    expect([...metadata.files.values()][0]?.lifecycleStatus).toBe(lifecycleStatus);
    expect(provider.objects.size).toBe(policy === 'reject' ? 0 : 1);
  });

  it('marks multipart size mismatches failed and prevents abort after completion', async () => {
    const { storage, metadata } = setup();
    const mismatch = await storage.createMultipartUpload({
      namespace: 'business/1',
      contentType: 'application/pdf',
      contentLength: 100,
      idempotencyKey: 'size-mismatch',
    });
    await storage.uploadPart(mismatch.id, 1, Readable.from('%PDF short'), 10);
    await expect(storage.completeMultipartUpload(mismatch.id)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect((await metadata.getUpload(mismatch.id))?.status).toBe('failed');

    const bytes = Buffer.from('%PDF complete');
    const complete = await storage.createMultipartUpload({
      namespace: 'business/1',
      contentType: 'application/pdf',
      contentLength: bytes.length,
      idempotencyKey: 'abort-completed',
    });
    await storage.uploadPart(complete.id, 1, Readable.from(bytes), bytes.length);
    await storage.completeMultipartUpload(complete.id);
    await expect(storage.abortMultipartUpload(complete.id)).rejects.toMatchObject({
      code: 'UPLOAD_STATE_CONFLICT',
    });
  });

  it('restores generated variants together with their parent', async () => {
    const processor = {
      name: 'thumbnail',
      supports: () => true,
      process: vi
        .fn()
        .mockResolvedValue([
          { name: 'thumb', contentType: 'image/jpeg', stream: Readable.from(jpeg) },
        ]),
    };
    const { storage, metadata } = setup({ processors: [processor] });
    const owner = { type: 'user' as const, id: 'owner' };
    const file = await storage.upload({
      namespace: 'business/1',
      stream: Readable.from(jpeg),
      contentType: 'image/jpeg',
      contentLength: jpeg.length,
      access: { mode: 'restricted', owner, policyVersion: 1 },
    });
    const childId = file.variants[0]!.fileId;
    await storage.softDelete(file.id, owner);
    expect((await metadata.getFile(childId))?.lifecycleStatus).toBe('soft-deleted');
    await storage.restore(file.id, owner);
    expect((await metadata.getFile(childId))?.lifecycleStatus).toBe('available');
  });

  it('does not roll back stored files when an event sink is unavailable', async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { storage, provider } = setup({
      logger,
      events: { publish: vi.fn().mockRejectedValue(new Error('event bus offline')) },
    });
    await expect(
      storage.upload({
        namespace: 'business/1',
        stream: Readable.from(jpeg),
        contentType: 'image/jpeg',
        contentLength: jpeg.length,
      }),
    ).resolves.toMatchObject({ lifecycleStatus: 'available' });
    expect(provider.objects.size).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      'File event publication failed',
      expect.objectContaining({ eventType: 'file.uploaded' }),
    );
  });

  it('authorizes every multipart action against the owning file', async () => {
    const metadata = new MemoryMetadataStore();
    const storage = createFileStorage({
      provider: new MemoryBlobProvider(),
      metadata,
      authorizer: new MongooseAclAuthorizer(metadata),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const owner = { type: 'user' as const, id: 'owner' };
    const session = await storage.createMultipartUpload({
      namespace: 'business/1',
      contentType: 'application/pdf',
      contentLength: 9,
      idempotencyKey: 'secured-upload',
      access: { mode: 'restricted', owner, policyVersion: 1 },
    });
    const stranger = { type: 'user' as const, id: 'stranger' };
    await expect(
      storage.uploadPart(session.id, 1, Readable.from('%PDF part'), 9, {
        principal: stranger,
      }),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    await expect(storage.resumeMultipartUpload(session.id, stranger)).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
    });
    await storage.uploadPart(session.id, 1, Readable.from('%PDF part'), 9, { principal: owner });
    await expect(storage.completeMultipartUpload(session.id, owner)).resolves.toMatchObject({
      lifecycleStatus: 'available',
    });
  });

  it('supports exact MIME policies and explicit SVG opt-in', async () => {
    const pdf = Buffer.from('%PDF exact');
    const exact = setup({ allowedContentTypes: ['application/pdf'] });
    await expect(
      exact.storage.upload({
        namespace: 'business/1',
        stream: Readable.from(pdf),
        contentType: 'application/pdf',
        contentLength: pdf.length,
      }),
    ).resolves.toMatchObject({ contentType: 'application/pdf' });
    const svg = Buffer.from('<svg></svg>');
    const optedIn = setup({ allowedContentTypes: ['image/svg+xml'], rejectSvg: false });
    await expect(
      optedIn.storage.upload({
        namespace: 'business/1',
        stream: Readable.from(svg),
        contentType: 'image/svg+xml',
        contentLength: svg.length,
      }),
    ).resolves.toMatchObject({ contentType: 'image/svg+xml' });
  });

  it('expires temporary files after seven days while preserving permanent files', async () => {
    let now = new Date('2026-01-01T00:00:00.000Z');
    const { storage, metadata, provider } = setup({ now: () => now });
    const temporary = await storage.upload({
      namespace: 'business/1',
      stream: Readable.from(jpeg),
      contentType: 'image/jpeg',
      contentLength: jpeg.length,
      retention: { mode: 'temporary' },
    });
    const permanent = await storage.upload({
      namespace: 'business/1',
      stream: Readable.from(jpeg),
      contentType: 'image/jpeg',
      contentLength: jpeg.length,
    });
    expect(temporary.retention).toEqual({
      mode: 'temporary',
      expiresAt: new Date('2026-01-08T00:00:00.000Z'),
    });
    expect(permanent.retention).toEqual({ mode: 'permanent' });
    now = new Date('2026-01-08T00:00:00.001Z');
    await expect(storage.openDownload(temporary.id)).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
    });
    await expect(
      storage.markPermanent(temporary.id, { type: 'user', id: 'owner' }),
    ).rejects.toMatchObject({ code: 'UPLOAD_STATE_CONFLICT' });
    expect(await storage.cleanupExpiredTemporaryFiles()).toEqual({
      examined: 1,
      deleted: 1,
      failed: 0,
    });
    expect((await metadata.getFile(temporary.id))?.lifecycleStatus).toBe('permanently-deleted');
    expect((await metadata.getFile(permanent.id))?.lifecycleStatus).toBe('available');
    expect(provider.objects.size).toBe(1);
  });

  it('never signs a temporary download beyond its retention deadline', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const { storage, provider } = setup({ now: () => now });
    const sign = vi.spyOn(provider, 'signDownload');
    const file = await storage.upload({
      namespace: 'business/1',
      stream: Readable.from(jpeg),
      contentType: 'image/jpeg',
      contentLength: jpeg.length,
      retention: { mode: 'temporary', expiresAt: new Date(now.getTime() + 60_000) },
    });
    await storage.createSignedDownload(file.id, null, 3600);
    expect(sign).toHaveBeenCalledWith(expect.objectContaining({ expiresInSeconds: 60 }));
  });

  it('promotes temporary files and generated variants to permanent retention', async () => {
    const processor = {
      name: 'thumbnail',
      supports: () => true,
      process: vi
        .fn()
        .mockResolvedValue([
          { name: 'thumb', contentType: 'image/jpeg', stream: Readable.from(jpeg) },
        ]),
    };
    const { storage, metadata } = setup({ processors: [processor] });
    const file = await storage.upload({
      namespace: 'business/1',
      stream: Readable.from(jpeg),
      contentType: 'image/jpeg',
      contentLength: jpeg.length,
      retention: { mode: 'temporary', expiresAt: new Date('2027-01-02T00:00:00.000Z') },
    });
    const promoted = await storage.markPermanent(file.id, { type: 'user', id: 'owner' });
    expect(promoted.retention).toEqual({ mode: 'permanent' });
    expect((await metadata.getFile(file.variants[0]!.fileId))?.retention).toEqual({
      mode: 'permanent',
    });
    expect(
      await storage.cleanupExpiredTemporaryFiles({ before: new Date('2028-01-01T00:00:00.000Z') }),
    ).toEqual({ examined: 0, deleted: 0, failed: 0 });
  });

  it('leaves metadata recoverably soft-deleted when temporary byte deletion fails', async () => {
    const { storage, metadata, provider } = setup();
    const file = await storage.upload({
      namespace: 'business/1',
      stream: Readable.from(jpeg),
      contentType: 'image/jpeg',
      contentLength: jpeg.length,
      retention: { mode: 'temporary', expiresAt: new Date(0) },
    });
    vi.spyOn(provider, 'delete').mockRejectedValueOnce(new Error('MinIO unavailable'));
    expect(await storage.cleanupExpiredTemporaryFiles()).toEqual({
      examined: 1,
      deleted: 0,
      failed: 1,
    });
    expect((await metadata.getFile(file.id))?.lifecycleStatus).toBe('soft-deleted');
    expect(provider.objects.has(file.objectKey)).toBe(true);
  });

  it('requires update authorization before making a temporary file permanent', async () => {
    const metadata = new MemoryMetadataStore();
    const storage = createFileStorage({
      provider: new MemoryBlobProvider(),
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
      retention: { mode: 'temporary' },
    });
    await expect(
      storage.markPermanent(file.id, { type: 'user', id: 'stranger' }),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    await expect(storage.markPermanent(file.id, owner)).resolves.toMatchObject({
      retention: { mode: 'permanent' },
    });
  });
});
