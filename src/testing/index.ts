import { Readable } from 'node:stream';
import type {
  BlobProvider,
  FileGrant,
  FileRecord,
  MetadataStore,
  MultipartPart,
  PrincipalRef,
  UploadSession,
} from '../contracts.js';
import { FileStorageError } from '../errors.js';

export class MemoryMetadataStore implements MetadataStore {
  readonly files = new Map<string, FileRecord>();
  readonly uploads = new Map<string, UploadSession>();
  readonly grants = new Map<string, FileGrant>();
  async createFile(file: FileRecord) {
    if (this.files.has(file.id)) throw new FileStorageError('METADATA_ERROR', 'Duplicate file');
    this.files.set(file.id, structuredClone(file));
    return structuredClone(file);
  }
  async getFile(id: string) {
    return structuredClone(this.files.get(id) ?? null);
  }
  async updateFile(id: string, expected: Date, patch: Partial<FileRecord>) {
    const current = this.files.get(id);
    if (!current || current.updatedAt.getTime() !== expected.getTime())
      throw new FileStorageError('METADATA_ERROR', 'Concurrent file update');
    const next = { ...current, ...structuredClone(patch) };
    this.files.set(id, next);
    return structuredClone(next);
  }
  async findFiles(query: {
    lifecycleStatus?: FileRecord['lifecycleStatus'];
    lifecycleStatuses?: readonly FileRecord['lifecycleStatus'][];
    deletedBefore?: Date;
    expiresBefore?: Date;
    retentionMode?: FileRecord['retention']['mode'];
    namespace?: string;
    limit: number;
  }) {
    return [...this.files.values()]
      .filter((file) => !query.lifecycleStatus || file.lifecycleStatus === query.lifecycleStatus)
      .filter(
        (file) =>
          !query.lifecycleStatuses || query.lifecycleStatuses.includes(file.lifecycleStatus),
      )
      .filter((file) => !query.retentionMode || file.retention.mode === query.retentionMode)
      .filter(
        (file) =>
          !query.expiresBefore ||
          (file.retention.mode === 'temporary' &&
            file.retention.expiresAt.getTime() <= query.expiresBefore.getTime()),
      )
      .filter((file) => !query.namespace || file.namespace === query.namespace)
      .filter(
        (file) =>
          !query.deletedBefore ||
          Boolean(file.deletedAt && file.deletedAt.getTime() <= query.deletedBefore.getTime()),
      )
      .slice(0, query.limit)
      .map((file) => structuredClone(file));
  }
  async createUpload(value: UploadSession) {
    this.uploads.set(value.id, structuredClone(value));
    return structuredClone(value);
  }
  async getUpload(id: string) {
    return structuredClone(this.uploads.get(id) ?? null);
  }
  async findUploadByIdempotencyKey(namespace: string, key: string) {
    return structuredClone(
      [...this.uploads.values()].find(
        (value) => value.namespace === namespace && value.idempotencyKey === key,
      ) ?? null,
    );
  }
  async updateUpload(id: string, expected: Date, patch: Partial<UploadSession>) {
    const current = this.uploads.get(id);
    if (!current || current.updatedAt.getTime() !== expected.getTime())
      throw new FileStorageError('METADATA_ERROR', 'Concurrent upload update');
    const next = { ...current, ...structuredClone(patch) };
    this.uploads.set(id, next);
    return structuredClone(next);
  }
  async listExpiredUploads(before: Date, limit: number) {
    return [...this.uploads.values()]
      .filter((value) => value.expiresAt < before)
      .slice(0, limit)
      .map((value) => structuredClone(value));
  }
  async listGrants(fileId: string) {
    return [...this.grants.values()]
      .filter((value) => value.fileId === fileId)
      .map((value) => structuredClone(value));
  }
  async putGrant(grant: FileGrant) {
    const key = `${grant.fileId}:${grant.principal.type}:${grant.principal.id}`;
    this.grants.set(key, structuredClone(grant));
    return structuredClone(grant);
  }
  async revokeGrant(fileId: string, principal: PrincipalRef) {
    this.grants.delete(`${fileId}:${principal.type}:${principal.id}`);
  }
}

export class MemoryBlobProvider implements BlobProvider {
  readonly capabilities = { multipart: true, signedDownloads: true, ranges: true } as const;
  readonly objects = new Map<string, { data: Buffer; contentType: string }>();
  readonly multipart = new Map<
    string,
    { key: string; contentType: string; parts: Map<number, Buffer> }
  >();
  async put(input: Parameters<BlobProvider['put']>[0]) {
    const chunks: Buffer[] = [];
    for await (const chunk of input.body)
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    const data = Buffer.concat(chunks);
    this.objects.set(input.key, { data, contentType: input.contentType });
    return { key: input.key, size: data.length, contentType: input.contentType };
  }
  async getStream(key: string, options: { start?: number; end?: number } = {}) {
    const object = this.objects.get(key);
    if (!object) throw new FileStorageError('FILE_NOT_FOUND', 'Object not found');
    return Readable.from(
      object.data.subarray(
        options.start ?? 0,
        options.end === undefined ? undefined : options.end + 1,
      ),
    );
  }
  async head(key: string) {
    const object = this.objects.get(key);
    return object ? { key, size: object.data.length, contentType: object.contentType } : null;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async createMultipart(input: { key: string; contentType: string }) {
    const uploadId = crypto.randomUUID();
    this.multipart.set(uploadId, { ...input, parts: new Map() });
    return { uploadId };
  }
  async uploadPart(input: {
    uploadId: string;
    partNumber: number;
    body: Readable;
    contentLength: number;
  }) {
    const upload = this.multipart.get(input.uploadId);
    if (!upload) throw new FileStorageError('UPLOAD_NOT_FOUND', 'Upload not found');
    const chunks: Buffer[] = [];
    for await (const chunk of input.body)
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    const data = Buffer.concat(chunks);
    upload.parts.set(input.partNumber, data);
    return { partNumber: input.partNumber, etag: `etag-${input.partNumber}`, size: data.length };
  }
  async listParts(input: { uploadId: string }) {
    const upload = this.multipart.get(input.uploadId);
    if (!upload) throw new FileStorageError('UPLOAD_NOT_FOUND', 'Upload not found');
    return [...upload.parts]
      .sort(([a], [b]) => a - b)
      .map(([partNumber, data]): MultipartPart => ({
        partNumber,
        etag: `etag-${partNumber}`,
        size: data.length,
      }));
  }
  async completeMultipart(input: {
    key: string;
    uploadId: string;
    parts: readonly MultipartPart[];
  }) {
    const upload = this.multipart.get(input.uploadId);
    if (!upload) throw new FileStorageError('UPLOAD_NOT_FOUND', 'Upload not found');
    const data = Buffer.concat(
      input.parts.map((part) => upload.parts.get(part.partNumber) ?? Buffer.alloc(0)),
    );
    this.objects.set(input.key, { data, contentType: upload.contentType });
    this.multipart.delete(input.uploadId);
    return { key: input.key, size: data.length, contentType: upload.contentType };
  }
  async abortMultipart(input: { uploadId: string }) {
    this.multipart.delete(input.uploadId);
  }
  async signDownload(input: { key: string; expiresInSeconds: number }) {
    return `memory://${input.key}?expires=${input.expiresInSeconds}`;
  }
}
