import { createHash, randomUUID } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import type {
  AccessPrincipal,
  BlobProvider,
  FileAccess,
  FileAction,
  FileAuthorizer,
  FileEventSink,
  FileProcessor,
  FileRecord,
  FileRetentionInput,
  FileStorageLogger,
  MalwareScanner,
  MetadataStore,
  MultipartPart,
  PrincipalRef,
  ScannerUnavailablePolicy,
  UploadSession,
} from './contracts.js';
import { FileStorageError, asFileStorageError } from './errors.js';
import { detectContentType } from './mime.js';
import { fileStorageOptionsSchema, multipartInputSchema, uploadInputSchema } from './schemas.js';

const consoleLogger: FileStorageLogger = {
  debug: (message, context) => console.debug(message, context ?? ''),
  info: (message, context) => console.info(message, context ?? ''),
  warn: (message, context) => console.warn(message, context ?? ''),
  error: (message, context) => console.error(message, context ?? ''),
};

export interface CreateFileStorageOptions {
  provider: BlobProvider;
  metadata: MetadataStore;
  authorizer?: FileAuthorizer;
  scanner?: MalwareScanner;
  processors?: readonly FileProcessor[];
  logger?: FileStorageLogger;
  events?: FileEventSink;
  storageTarget?: string;
  maxFileSize?: number;
  multipartPartSize?: number;
  uploadSessionTtlMs?: number;
  temporaryFileTtlMs?: number;
  signedUrlMaxExpirySeconds?: number;
  scannerUnavailablePolicy?: ScannerUnavailablePolicy;
  allowedContentTypes?: readonly string[];
  rejectSvg?: boolean;
  now?: () => Date;
  idGenerator?: () => string;
}

export interface UploadFileInput {
  namespace: string;
  stream: Readable;
  filename?: string;
  contentType: string;
  contentLength: number;
  purpose?: string;
  access?: FileAccess;
  retention?: FileRetentionInput;
  metadata?: Readonly<Record<string, unknown>>;
  references?: readonly { type: string; id: string; role?: string }[];
  signal?: AbortSignal;
}

export interface CreateMultipartUploadInput extends Omit<UploadFileInput, 'stream' | 'signal'> {
  idempotencyKey: string;
  partSize?: number;
}

function keyFor(namespace: string, fileId: string): string {
  const tenant = createHash('sha256').update(namespace).digest('hex').slice(0, 24);
  return `objects/${tenant}/${fileId}`;
}

function retentionMatches(existing: FileRetentionInput, requested: FileRetentionInput): boolean {
  if (existing.mode !== requested.mode) return false;
  if (existing.mode === 'permanent' || requested.mode === 'permanent') return true;
  return (
    requested.expiresAt === undefined ||
    existing.expiresAt?.getTime() === requested.expiresAt.getTime()
  );
}

function createMeter(maxBytes: number) {
  const hash = createHash('sha256');
  const header: Buffer[] = [];
  let headerBytes = 0;
  let size = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > maxBytes)
        return callback(new FileStorageError('FILE_TOO_LARGE', `File exceeds ${maxBytes} bytes`));
      hash.update(chunk);
      if (headerBytes < 64) {
        const slice = chunk.subarray(0, Math.min(chunk.length, 64 - headerBytes));
        header.push(slice);
        headerBytes += slice.length;
      }
      callback(null, chunk);
    },
  });
  return {
    stream,
    result: () => ({ size, sha256: hash.digest('hex'), header: Buffer.concat(header) }),
  };
}

export class FileStorage {
  private readonly provider: BlobProvider;
  private readonly metadata: MetadataStore;
  private readonly authorizer: FileAuthorizer | undefined;
  private readonly scanner: MalwareScanner | undefined;
  private readonly processors: readonly FileProcessor[];
  private readonly logger: FileStorageLogger;
  private readonly events: FileEventSink | undefined;
  private readonly config: ReturnType<typeof fileStorageOptionsSchema.parse>;
  private readonly now: () => Date;
  private readonly id: () => string;
  private warnedScannerUnavailable = false;

  constructor(options: CreateFileStorageOptions) {
    this.provider = options.provider;
    this.metadata = options.metadata;
    this.authorizer = options.authorizer;
    this.scanner = options.scanner;
    this.processors = options.processors ?? [];
    this.logger = options.logger ?? consoleLogger;
    this.events = options.events;
    this.config = fileStorageOptionsSchema.parse(options);
    this.now = options.now ?? (() => new Date());
    this.id = options.idGenerator ?? randomUUID;
    if (!this.scanner)
      this.logger.warn(
        'File malware scanning is disabled; files will be validated but not scanned.',
      );
  }

  async upload(input: UploadFileInput): Promise<FileRecord> {
    const parsed = uploadInputSchema.parse(input);
    if (parsed.contentLength > this.config.maxFileSize)
      throw new FileStorageError('FILE_TOO_LARGE', 'File exceeds configured maximum');
    const file = await this.createPendingFile(parsed);
    const meter = createMeter(this.config.maxFileSize);
    input.stream.once('error', (error) => meter.stream.destroy(error));
    input.stream.pipe(meter.stream);
    try {
      await this.provider.put({
        key: file.objectKey,
        body: meter.stream,
        contentType: parsed.contentType,
        contentLength: parsed.contentLength,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const measured = meter.result();
      if (measured.size !== parsed.contentLength)
        throw new FileStorageError('INVALID_INPUT', 'Content length does not match uploaded bytes');
      const detected = detectContentType(measured.header) ?? 'application/octet-stream';
      this.validateContentType(detected, parsed.contentType);
      let completed = await this.metadata.updateFile(file.id, file.updatedAt, {
        size: measured.size,
        sha256: measured.sha256,
        contentType: detected,
        lifecycleStatus: this.scanner ? 'quarantined' : 'available',
        updatedAt: this.now(),
      });
      completed = await this.scan(completed);
      completed = await this.process(completed);
      await this.emit('file.uploaded', completed.id, {
        size: completed.size,
        contentType: completed.contentType,
      });
      return completed;
    } catch (error) {
      await this.provider.delete(file.objectKey).catch(() => undefined);
      await this.failFile(file, error);
      throw asFileStorageError(error, 'PROVIDER_ERROR');
    }
  }

  async createMultipartUpload(input: CreateMultipartUploadInput): Promise<UploadSession> {
    if (!this.provider.capabilities.multipart)
      throw new FileStorageError(
        'UNSUPPORTED_OPERATION',
        'Provider does not support multipart uploads',
      );
    const parsed = multipartInputSchema.parse(input);
    if (parsed.contentLength > this.config.maxFileSize)
      throw new FileStorageError('FILE_TOO_LARGE', 'File exceeds configured maximum');
    const existing = await this.metadata.findUploadByIdempotencyKey(
      parsed.namespace,
      parsed.idempotencyKey,
    );
    if (existing) {
      if (
        existing.expectedSize !== parsed.contentLength ||
        existing.contentType !== parsed.contentType ||
        !retentionMatches(existing.retention ?? { mode: 'permanent' }, parsed.retention)
      )
        throw new FileStorageError(
          'UPLOAD_STATE_CONFLICT',
          'Idempotency key was already used with different upload parameters',
        );
      return existing;
    }
    const file = await this.createPendingFile(parsed);
    const created = await this.provider.createMultipart({
      key: file.objectKey,
      contentType: parsed.contentType,
    });
    const now = this.now();
    const session: UploadSession = {
      id: this.id(),
      fileId: file.id,
      idempotencyKey: parsed.idempotencyKey,
      namespace: parsed.namespace,
      storageTarget: this.config.storageTarget,
      objectKey: file.objectKey,
      providerUploadId: created.uploadId,
      status: 'initiated',
      expectedSize: parsed.contentLength,
      partSize: parsed.partSize ?? this.config.multipartPartSize,
      contentType: parsed.contentType,
      ...(parsed.filename ? { filename: parsed.filename } : {}),
      ...(parsed.purpose ? { purpose: parsed.purpose } : {}),
      access: file.access,
      retention: file.retention,
      parts: [],
      expiresAt: new Date(now.getTime() + this.config.uploadSessionTtlMs),
      createdAt: now,
      updatedAt: now,
    };
    try {
      return await this.metadata.createUpload(session);
    } catch (error) {
      // Another request may have won the unique namespace/idempotency-key race.
      const raced = await this.metadata
        .findUploadByIdempotencyKey(parsed.namespace, parsed.idempotencyKey)
        .catch(() => null);
      if (!raced) throw error;
      await this.provider
        .abortMultipart({ key: file.objectKey, uploadId: created.uploadId })
        .catch(() => undefined);
      await this.failFile(file, error);
      if (
        raced.expectedSize !== parsed.contentLength ||
        raced.contentType !== parsed.contentType ||
        !retentionMatches(raced.retention ?? { mode: 'permanent' }, parsed.retention)
      )
        throw new FileStorageError(
          'UPLOAD_STATE_CONFLICT',
          'Idempotency key was concurrently used with different upload parameters',
        );
      return raced;
    }
  }

  async uploadPart(
    uploadId: string,
    partNumber: number,
    body: Readable,
    contentLength: number,
    options: { signal?: AbortSignal; principal?: AccessPrincipal | null } = {},
  ): Promise<MultipartPart> {
    const session = await this.requireUpload(uploadId);
    await this.authorizeUpload(session, options.principal ?? null);
    if (!['initiated', 'uploading'].includes(session.status))
      throw new FileStorageError('UPLOAD_STATE_CONFLICT', 'Upload is not accepting parts');
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000)
      throw new FileStorageError('INVALID_INPUT', 'Part number must be between 1 and 10000');
    if (contentLength < 1 || contentLength > session.partSize)
      throw new FileStorageError('INVALID_INPUT', 'Part length exceeds configured part size');
    const part = await this.provider.uploadPart({
      key: session.objectKey,
      uploadId: session.providerUploadId,
      partNumber,
      body,
      contentLength,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    await this.reconcileUpload(session.id, 'uploading');
    return part;
  }

  async resumeMultipartUpload(
    uploadId: string,
    principal: AccessPrincipal | null = null,
  ): Promise<UploadSession> {
    const session = await this.requireUpload(uploadId);
    await this.authorizeUpload(session, principal);
    return this.reconcileUpload(session.id);
  }

  async completeMultipartUpload(
    uploadId: string,
    principal: AccessPrincipal | null = null,
  ): Promise<FileRecord> {
    let session = await this.requireUpload(uploadId);
    await this.authorizeUpload(session, principal);
    if (session.status === 'completed') return this.requireFile(session.fileId);
    const parts = await this.provider.listParts({
      key: session.objectKey,
      uploadId: session.providerUploadId,
    });
    session = await this.metadata.updateUpload(session.id, session.updatedAt, {
      status: 'finalizing',
      parts,
      updatedAt: this.now(),
    });
    try {
      const blob = await this.provider.completeMultipart({
        key: session.objectKey,
        uploadId: session.providerUploadId,
        parts,
      });
      if (blob.size !== session.expectedSize)
        throw new FileStorageError(
          'INVALID_INPUT',
          'Completed object size does not match expected size',
        );
      const file = await this.requireFile(session.fileId);
      const measured = await this.inspectObject(session.objectKey);
      const detected = detectContentType(measured.header) ?? session.contentType;
      this.validateContentType(detected, session.contentType);
      let completed = await this.metadata.updateFile(file.id, file.updatedAt, {
        size: measured.size,
        sha256: measured.sha256,
        contentType: detected,
        lifecycleStatus: this.scanner ? 'quarantined' : 'available',
        updatedAt: this.now(),
      });
      await this.metadata.updateUpload(session.id, session.updatedAt, {
        status: 'completed',
        updatedAt: this.now(),
      });
      completed = await this.scan(completed);
      completed = await this.process(completed);
      await this.emit('file.uploaded', completed.id, { multipart: true, size: completed.size });
      return completed;
    } catch (error) {
      await this.metadata
        .updateUpload(session.id, session.updatedAt, { status: 'failed', updatedAt: this.now() })
        .catch(() => undefined);
      throw asFileStorageError(error, 'PROVIDER_ERROR');
    }
  }

  async abortMultipartUpload(
    uploadId: string,
    principal: AccessPrincipal | null = null,
  ): Promise<void> {
    const session = await this.requireUpload(uploadId);
    await this.authorizeUpload(session, principal);
    if (session.status === 'aborted') return;
    if (session.status === 'completed')
      throw new FileStorageError('UPLOAD_STATE_CONFLICT', 'Completed upload cannot be aborted');
    await this.provider.abortMultipart({
      key: session.objectKey,
      uploadId: session.providerUploadId,
    });
    await this.metadata.updateUpload(session.id, session.updatedAt, {
      status: 'aborted',
      updatedAt: this.now(),
    });
  }

  async getFile(fileId: string, principal: AccessPrincipal | null = null): Promise<FileRecord> {
    const file = await this.requireFile(fileId);
    await this.assertAuthorized(principal, 'read', file);
    return file;
  }

  async openDownload(fileId: string, principal: AccessPrincipal | null = null): Promise<Readable> {
    const file = await this.requireFile(fileId);
    await this.assertAuthorized(principal, 'download', file);
    this.assertDownloadable(file);
    return this.provider.getStream(file.objectKey);
  }

  async createSignedDownload(
    fileId: string,
    principal: AccessPrincipal | null,
    expiresInSeconds = 300,
  ): Promise<string> {
    const file = await this.requireFile(fileId);
    await this.assertAuthorized(principal, 'download', file);
    this.assertDownloadable(file);
    if (!this.provider.signDownload)
      throw new FileStorageError(
        'UNSUPPORTED_OPERATION',
        'Provider does not support signed downloads',
      );
    const retentionExpiry =
      file.retention.mode === 'temporary'
        ? Math.floor((file.retention.expiresAt.getTime() - this.now().getTime()) / 1000)
        : this.config.signedUrlMaxExpirySeconds;
    if (retentionExpiry < 1)
      throw new FileStorageError('ACCESS_DENIED', 'Temporary file has expired');
    return this.provider.signDownload({
      key: file.objectKey,
      expiresInSeconds: Math.min(
        expiresInSeconds,
        this.config.signedUrlMaxExpirySeconds,
        retentionExpiry,
      ),
      ...(file.originalFilename ? { filename: file.originalFilename } : {}),
    });
  }

  async grantAccess(
    fileId: string,
    actor: AccessPrincipal,
    grant: {
      principal: PrincipalRef;
      actions: readonly FileAction[];
      expiresAt?: Date;
    },
  ) {
    const file = await this.requireFile(fileId);
    await this.assertAuthorized(actor, 'manage-access', file);
    const now = this.now();
    return this.metadata.putGrant({
      id: this.id(),
      fileId,
      principal: grant.principal,
      actions: grant.actions,
      ...(grant.expiresAt ? { expiresAt: grant.expiresAt } : {}),
      createdAt: now,
    });
  }

  async revokeAccess(fileId: string, actor: AccessPrincipal, principal: PrincipalRef) {
    const file = await this.requireFile(fileId);
    await this.assertAuthorized(actor, 'manage-access', file);
    await this.metadata.revokeGrant(fileId, principal);
  }

  async markPermanent(fileId: string, actor: AccessPrincipal): Promise<FileRecord> {
    const file = await this.requireFile(fileId);
    await this.assertAuthorized(actor, 'update', file);
    if (file.retention.mode === 'permanent') return file;
    if (file.retention.expiresAt.getTime() <= this.now().getTime())
      throw new FileStorageError('UPLOAD_STATE_CONFLICT', 'Expired files cannot be made permanent');
    if (!['available', 'quarantined'].includes(file.lifecycleStatus))
      throw new FileStorageError(
        'UPLOAD_STATE_CONFLICT',
        'Only active temporary files can be made permanent',
      );
    const permanent = await this.metadata.updateFile(file.id, file.updatedAt, {
      retention: { mode: 'permanent' },
      updatedAt: this.now(),
    });
    for (const variant of file.variants) {
      const child = await this.metadata.getFile(variant.fileId);
      if (child?.retention.mode === 'temporary')
        await this.metadata.updateFile(child.id, child.updatedAt, {
          retention: { mode: 'permanent' },
          updatedAt: this.now(),
        });
    }
    await this.emit('file.marked-permanent', file.id, {});
    return permanent;
  }

  async softDelete(fileId: string, actor: AccessPrincipal): Promise<FileRecord> {
    const file = await this.requireFile(fileId);
    await this.assertAuthorized(actor, 'delete', file);
    const now = this.now();
    const deleted = await this.metadata.updateFile(file.id, file.updatedAt, {
      lifecycleStatus: 'soft-deleted',
      deletedAt: now,
      updatedAt: now,
    });
    for (const variant of file.variants) {
      const child = await this.metadata.getFile(variant.fileId);
      if (child && child.lifecycleStatus === 'available')
        await this.metadata.updateFile(child.id, child.updatedAt, {
          lifecycleStatus: 'soft-deleted',
          deletedAt: now,
          updatedAt: this.now(),
        });
    }
    await this.emit('file.soft-deleted', file.id, {});
    return deleted;
  }

  async restore(fileId: string, actor: AccessPrincipal): Promise<FileRecord> {
    const file = await this.requireFile(fileId);
    await this.assertAuthorized(actor, 'delete', file);
    if (file.lifecycleStatus !== 'soft-deleted')
      throw new FileStorageError(
        'UPLOAD_STATE_CONFLICT',
        'Only soft-deleted files can be restored',
      );
    if (!(await this.provider.head(file.objectKey)))
      throw new FileStorageError(
        'FILE_NOT_FOUND',
        'File bytes have already been permanently deleted',
      );
    const restored = await this.metadata.updateFile(file.id, file.updatedAt, {
      lifecycleStatus: 'available',
      deletedAt: null,
      updatedAt: this.now(),
    });
    for (const variant of file.variants) {
      const child = await this.metadata.getFile(variant.fileId);
      if (child?.lifecycleStatus === 'soft-deleted' && (await this.provider.head(child.objectKey)))
        await this.metadata.updateFile(child.id, child.updatedAt, {
          lifecycleStatus: 'available',
          deletedAt: null,
          updatedAt: this.now(),
        });
    }
    return restored;
  }

  async cleanupExpiredUploads(options: { before?: Date; limit?: number } = {}) {
    const sessions = await this.metadata.listExpiredUploads(
      options.before ?? this.now(),
      options.limit ?? 100,
    );
    let cleaned = 0;
    let failed = 0;
    for (const session of sessions) {
      try {
        await this.provider.abortMultipart({
          key: session.objectKey,
          uploadId: session.providerUploadId,
        });
        await this.metadata.updateUpload(session.id, session.updatedAt, {
          status: 'expired',
          updatedAt: this.now(),
        });
        const file = await this.metadata.getFile(session.fileId);
        if (file?.lifecycleStatus === 'pending')
          await this.metadata.updateFile(file.id, file.updatedAt, {
            lifecycleStatus: 'failed',
            updatedAt: this.now(),
          });
        cleaned++;
      } catch (error) {
        failed++;
        this.logger.error('Expired upload cleanup failed', {
          uploadId: session.id,
          errorCode: error instanceof FileStorageError ? error.code : 'UNKNOWN',
        });
      }
    }
    return { examined: sessions.length, cleaned, failed };
  }

  async cleanupExpiredTemporaryFiles(options: { before?: Date; limit?: number } = {}) {
    const before = options.before ?? this.now();
    const files = await this.metadata.findFiles({
      lifecycleStatuses: ['available', 'quarantined'],
      retentionMode: 'temporary',
      expiresBefore: before,
      limit: options.limit ?? 100,
    });
    let deleted = 0;
    let failed = 0;
    for (const file of files) {
      try {
        const claimedAt = this.now();
        const claimed = await this.metadata.updateFile(file.id, file.updatedAt, {
          lifecycleStatus: 'soft-deleted',
          deletedAt: claimedAt,
          updatedAt: claimedAt,
        });
        await this.provider.delete(file.objectKey);
        await this.metadata.updateFile(claimed.id, claimed.updatedAt, {
          lifecycleStatus: 'permanently-deleted',
          updatedAt: this.now(),
        });
        await this.emit('file.temporary-expired', file.id, {
          expiresAt: file.retention.mode === 'temporary' ? file.retention.expiresAt : undefined,
        });
        deleted++;
      } catch (error) {
        failed++;
        this.logger.error('Temporary file cleanup failed', {
          fileId: file.id,
          errorCode: error instanceof FileStorageError ? error.code : 'UNKNOWN',
        });
      }
    }
    return { examined: files.length, deleted, failed };
  }

  async purgeDeletedFiles(options: { before: Date; limit?: number }) {
    const files = await this.metadata.findFiles({
      lifecycleStatus: 'soft-deleted',
      deletedBefore: options.before,
      limit: options.limit ?? 100,
    });
    let purged = 0;
    let failed = 0;
    for (const file of files) {
      try {
        await this.provider.delete(file.objectKey);
        await this.metadata.updateFile(file.id, file.updatedAt, {
          lifecycleStatus: 'permanently-deleted',
          updatedAt: this.now(),
        });
        purged++;
      } catch (error) {
        failed++;
        this.logger.error('Permanent file deletion failed', {
          fileId: file.id,
          errorCode: error instanceof FileStorageError ? error.code : 'UNKNOWN',
        });
      }
    }
    return { examined: files.length, purged, failed };
  }

  private async createPendingFile(
    input: ReturnType<typeof uploadInputSchema.parse>,
  ): Promise<FileRecord> {
    const now = this.now();
    const id = this.id();
    return this.metadata.createFile({
      id,
      namespace: input.namespace,
      storageTarget: this.config.storageTarget,
      objectKey: keyFor(input.namespace, id),
      ...(input.filename ? { originalFilename: input.filename } : {}),
      declaredContentType: input.contentType,
      contentType: input.contentType,
      size: 0,
      sha256: '',
      ...(input.purpose ? { purpose: input.purpose } : {}),
      lifecycleStatus: 'pending',
      scanStatus: this.scanner ? 'pending' : 'not-required',
      processingStatus: this.processors.length ? 'pending' : 'not-required',
      retention:
        input.retention.mode === 'temporary'
          ? {
              mode: 'temporary',
              expiresAt:
                input.retention.expiresAt ??
                new Date(now.getTime() + this.config.temporaryFileTtlMs),
            }
          : { mode: 'permanent' },
      access: input.access
        ? {
            mode: input.access.mode,
            policyVersion: input.access.policyVersion,
            ...(input.access.owner ? { owner: input.access.owner } : {}),
          }
        : { mode: 'restricted', policyVersion: 1 },
      references: input.references.map((reference) => ({
        type: reference.type,
        id: reference.id,
        ...(reference.role ? { role: reference.role } : {}),
      })),
      variants: [],
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
    });
  }

  private async scan(file: FileRecord): Promise<FileRecord> {
    if (!this.scanner) return file;
    try {
      const result = await this.scanner.scan({
        stream: await this.provider.getStream(file.objectKey),
        size: file.size,
        sha256: file.sha256,
      });
      if (result.status === 'infected') {
        await this.metadata.updateFile(file.id, file.updatedAt, {
          scanStatus: 'infected',
          lifecycleStatus: 'quarantined',
          updatedAt: this.now(),
        });
        throw new FileStorageError('SCAN_INFECTED', 'Uploaded file was identified as malicious');
      }
      return this.metadata.updateFile(file.id, file.updatedAt, {
        scanStatus: 'clean',
        lifecycleStatus: 'available',
        updatedAt: this.now(),
      });
    } catch (error) {
      if (error instanceof FileStorageError && error.code === 'SCAN_INFECTED') throw error;
      if (this.config.scannerUnavailablePolicy === 'reject')
        throw new FileStorageError('SCAN_UNAVAILABLE', 'Malware scanner is unavailable', {
          cause: error,
          retryable: true,
        });
      if (!this.warnedScannerUnavailable) {
        this.logger.warn(
          'Malware scanner is unavailable; continuing according to configured policy.',
        );
        this.warnedScannerUnavailable = true;
      }
      return this.metadata.updateFile(file.id, file.updatedAt, {
        scanStatus: 'skipped-unavailable',
        lifecycleStatus:
          this.config.scannerUnavailablePolicy === 'quarantine' ? 'quarantined' : 'available',
        updatedAt: this.now(),
      });
    }
  }

  private async process(file: FileRecord): Promise<FileRecord> {
    if (file.lifecycleStatus !== 'available') return file;
    const context = { file, openStream: () => this.provider.getStream(file.objectKey) };
    const processors = this.processors.filter((processor) => processor.supports(context));
    if (!processors.length) {
      if (file.processingStatus === 'pending')
        return this.metadata.updateFile(file.id, file.updatedAt, {
          processingStatus: 'not-required',
          updatedAt: this.now(),
        });
      return file;
    }
    let current = file;
    let successes = 0;
    let failures = 0;
    for (const processor of processors) {
      try {
        const outputs = await processor.process({
          file: current,
          openStream: () => this.provider.getStream(current.objectKey),
        });
        for (const output of outputs) {
          const variantId = this.id();
          const objectKey = keyFor(current.namespace, variantId);
          const meter = createMeter(this.config.maxFileSize);
          output.stream.once('error', (error) => meter.stream.destroy(error));
          output.stream.pipe(meter.stream);
          await this.provider.put({
            key: objectKey,
            body: meter.stream,
            contentType: output.contentType,
          });
          const measured = meter.result();
          const now = this.now();
          await this.metadata.createFile({
            id: variantId,
            namespace: current.namespace,
            storageTarget: current.storageTarget,
            objectKey,
            contentType: output.contentType,
            size: measured.size,
            sha256: measured.sha256,
            purpose: `${current.purpose ?? 'file'}:${output.name}`,
            lifecycleStatus: 'available',
            scanStatus: 'not-required',
            processingStatus: 'not-required',
            retention: current.retention,
            access: current.access,
            references: [{ type: 'variant-of', id: current.id, role: output.name }],
            variants: [],
            metadata: output.metadata ?? {},
            createdAt: now,
            updatedAt: now,
          });
          const width =
            typeof output.metadata?.width === 'number' ? output.metadata.width : undefined;
          const height =
            typeof output.metadata?.height === 'number' ? output.metadata.height : undefined;
          current = await this.metadata.updateFile(current.id, current.updatedAt, {
            variants: [
              ...current.variants,
              {
                name: output.name,
                fileId: variantId,
                ...(width ? { width } : {}),
                ...(height ? { height } : {}),
                format: output.contentType,
              },
            ],
            updatedAt: this.now(),
          });
          successes++;
        }
      } catch (error) {
        failures++;
        this.logger.error('File processor failed', {
          fileId: current.id,
          processor: processor.name,
          errorCode: error instanceof FileStorageError ? error.code : 'PROCESSING_FAILED',
        });
      }
    }
    return this.metadata.updateFile(current.id, current.updatedAt, {
      processingStatus: failures ? (successes ? 'partial' : 'failed') : 'completed',
      updatedAt: this.now(),
    });
  }

  private async assertAuthorized(
    principal: AccessPrincipal | null,
    action: FileAction,
    file: FileRecord,
  ) {
    if (!this.authorizer) return;
    const decision = await this.authorizer.authorize({ principal, action, resource: file });
    if (!decision.allowed)
      throw new FileStorageError('ACCESS_DENIED', 'File access denied', {
        details: { reasonCode: decision.reasonCode },
      });
  }
  private async authorizeUpload(session: UploadSession, principal: AccessPrincipal | null) {
    if (!this.authorizer) return;
    await this.assertAuthorized(principal, 'update', await this.requireFile(session.fileId));
  }
  private async reconcileUpload(id: string, status?: UploadSession['status']) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await this.requireUpload(id);
      const parts = await this.provider.listParts({
        key: current.objectKey,
        uploadId: current.providerUploadId,
      });
      try {
        return await this.metadata.updateUpload(current.id, current.updatedAt, {
          parts,
          ...(status ? { status } : {}),
          updatedAt: this.now(),
        });
      } catch (error) {
        lastError = error;
      }
    }
    throw asFileStorageError(lastError, 'METADATA_ERROR');
  }
  private async inspectObject(key: string) {
    const hash = createHash('sha256');
    const header: Buffer[] = [];
    let headerBytes = 0;
    let size = 0;
    const stream = await this.provider.getStream(key);
    for await (const raw of stream) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
      size += chunk.length;
      if (size > this.config.maxFileSize)
        throw new FileStorageError('FILE_TOO_LARGE', 'Completed object exceeds configured maximum');
      hash.update(chunk);
      if (headerBytes < 64) {
        const slice = chunk.subarray(0, Math.min(chunk.length, 64 - headerBytes));
        header.push(slice);
        headerBytes += slice.length;
      }
    }
    return { size, sha256: hash.digest('hex'), header: Buffer.concat(header) };
  }
  private validateContentType(detected: string, declared: string): void {
    if (this.config.rejectSvg && (detected === 'image/svg+xml' || declared === 'image/svg+xml'))
      throw new FileStorageError('MIME_NOT_ALLOWED', 'SVG files are disabled by policy');
    const allowed = this.config.allowedContentTypes;
    if (
      allowed &&
      !allowed.some((pattern) => {
        if (pattern.endsWith('/*')) return detected.startsWith(pattern.slice(0, -1));
        return pattern === detected;
      })
    )
      throw new FileStorageError('MIME_NOT_ALLOWED', 'Detected file type is not allowed', {
        details: { detected, declared },
      });
  }
  private assertDownloadable(file: FileRecord) {
    if (
      file.retention.mode === 'temporary' &&
      file.retention.expiresAt.getTime() <= this.now().getTime()
    )
      throw new FileStorageError('ACCESS_DENIED', 'Temporary file has expired');
    if (
      file.lifecycleStatus !== 'available' ||
      !['clean', 'not-required', 'skipped-unavailable'].includes(file.scanStatus)
    )
      throw new FileStorageError('ACCESS_DENIED', 'File is not available for download');
  }
  private async requireFile(id: string) {
    const file = await this.metadata.getFile(id);
    if (!file) throw new FileStorageError('FILE_NOT_FOUND', 'File not found');
    return file;
  }
  private async requireUpload(id: string) {
    const upload = await this.metadata.getUpload(id);
    if (!upload) throw new FileStorageError('UPLOAD_NOT_FOUND', 'Upload not found');
    return upload;
  }
  private async failFile(file: FileRecord, error: unknown) {
    const current = await this.metadata.getFile(file.id).catch(() => null);
    if (current && current.scanStatus !== 'infected')
      await this.metadata
        .updateFile(current.id, current.updatedAt, {
          lifecycleStatus: 'failed',
          updatedAt: this.now(),
        })
        .catch(() => undefined);
    this.logger.error('File upload failed', {
      fileId: file.id,
      errorCode: error instanceof FileStorageError ? error.code : 'UNKNOWN',
    });
  }
  private async emit(type: string, fileId: string, data: Readonly<Record<string, unknown>>) {
    if (!this.events) return;
    try {
      await this.events.publish({ id: this.id(), type, fileId, occurredAt: this.now(), data });
    } catch (error) {
      this.logger.error('File event publication failed', {
        fileId,
        eventType: type,
        errorCode: error instanceof FileStorageError ? error.code : 'UNKNOWN',
      });
    }
  }
}

export function createFileStorage(options: CreateFileStorageOptions): FileStorage {
  return new FileStorage(options);
}
