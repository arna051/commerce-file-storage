import type { Readable } from 'node:stream';

export type FileLifecycleStatus =
  'pending' | 'quarantined' | 'available' | 'failed' | 'soft-deleted' | 'permanently-deleted';
export type ScanStatus =
  'not-required' | 'pending' | 'clean' | 'infected' | 'error' | 'skipped-unavailable';
export type ProcessingStatus = 'not-required' | 'pending' | 'completed' | 'partial' | 'failed';
export type AccessMode = 'public' | 'authenticated' | 'restricted';
export type PrincipalType = 'user' | 'group' | 'role' | 'service';
export type FileAction = 'read' | 'download' | 'update' | 'delete' | 'share' | 'manage-access';

export interface PrincipalRef {
  type: PrincipalType;
  id: string;
}
export interface AccessPrincipal extends PrincipalRef {
  groups?: readonly string[];
  roles?: readonly string[];
  scopes?: readonly string[];
}
export interface FileAccess {
  mode: AccessMode;
  owner?: PrincipalRef;
  policyVersion: number;
}
export interface FileReference {
  type: string;
  id: string;
  role?: string;
}
export interface FileVariant {
  name: string;
  fileId: string;
  width?: number;
  height?: number;
  format?: string;
}

export interface FileRecord {
  id: string;
  namespace: string;
  storageTarget: string;
  objectKey: string;
  originalFilename?: string;
  declaredContentType?: string;
  contentType: string;
  size: number;
  sha256: string;
  purpose?: string;
  lifecycleStatus: FileLifecycleStatus;
  scanStatus: ScanStatus;
  processingStatus: ProcessingStatus;
  access: FileAccess;
  references: readonly FileReference[];
  variants: readonly FileVariant[];
  metadata: Readonly<Record<string, unknown>>;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

export interface FileGrant {
  id: string;
  fileId: string;
  principal: PrincipalRef;
  actions: readonly FileAction[];
  expiresAt?: Date;
  createdAt: Date;
}

export interface MultipartPart {
  partNumber: number;
  etag: string;
  size?: number;
  checksumSha256?: string;
}
export type UploadStatus =
  'initiated' | 'uploading' | 'finalizing' | 'completed' | 'aborted' | 'expired' | 'failed';
export interface UploadSession {
  id: string;
  fileId: string;
  idempotencyKey: string;
  namespace: string;
  storageTarget: string;
  objectKey: string;
  providerUploadId: string;
  status: UploadStatus;
  expectedSize: number;
  partSize: number;
  contentType: string;
  filename?: string;
  purpose?: string;
  access: FileAccess;
  parts: readonly MultipartPart[];
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface BlobHead {
  key: string;
  size: number;
  contentType?: string;
  etag?: string;
  checksumSha256?: string;
  metadata?: Readonly<Record<string, string>>;
}
export interface BlobProviderCapabilities {
  multipart: boolean;
  signedDownloads: boolean;
  ranges: boolean;
}
export interface PutBlobInput {
  key: string;
  body: Readable;
  contentType: string;
  contentLength?: number;
  checksumSha256?: string;
  metadata?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}
export interface MultipartCreateInput {
  key: string;
  contentType: string;
  metadata?: Readonly<Record<string, string>>;
}

export interface BlobProvider {
  readonly capabilities: BlobProviderCapabilities;
  put(input: PutBlobInput): Promise<BlobHead>;
  getStream(
    key: string,
    options?: { start?: number; end?: number; signal?: AbortSignal },
  ): Promise<Readable>;
  head(key: string): Promise<BlobHead | null>;
  delete(key: string): Promise<void>;
  createMultipart(input: MultipartCreateInput): Promise<{ uploadId: string }>;
  uploadPart(input: {
    key: string;
    uploadId: string;
    partNumber: number;
    body: Readable;
    contentLength: number;
    signal?: AbortSignal;
  }): Promise<MultipartPart>;
  listParts(input: { key: string; uploadId: string }): Promise<readonly MultipartPart[]>;
  completeMultipart(input: {
    key: string;
    uploadId: string;
    parts: readonly MultipartPart[];
  }): Promise<BlobHead>;
  abortMultipart(input: { key: string; uploadId: string }): Promise<void>;
  signDownload?(input: {
    key: string;
    expiresInSeconds: number;
    filename?: string;
  }): Promise<string>;
}

export interface MetadataStore {
  createFile(file: FileRecord): Promise<FileRecord>;
  getFile(id: string): Promise<FileRecord | null>;
  updateFile(id: string, expectedUpdatedAt: Date, patch: Partial<FileRecord>): Promise<FileRecord>;
  findFiles(query: {
    lifecycleStatus?: FileLifecycleStatus;
    deletedBefore?: Date;
    namespace?: string;
    limit: number;
  }): Promise<readonly FileRecord[]>;
  createUpload(session: UploadSession): Promise<UploadSession>;
  getUpload(id: string): Promise<UploadSession | null>;
  findUploadByIdempotencyKey(namespace: string, key: string): Promise<UploadSession | null>;
  updateUpload(
    id: string,
    expectedUpdatedAt: Date,
    patch: Partial<UploadSession>,
  ): Promise<UploadSession>;
  listExpiredUploads(before: Date, limit: number): Promise<readonly UploadSession[]>;
  listGrants(fileId: string): Promise<readonly FileGrant[]>;
  putGrant(grant: FileGrant): Promise<FileGrant>;
  revokeGrant(fileId: string, principal: PrincipalRef): Promise<void>;
}

export interface ScanResult {
  status: 'clean' | 'infected';
  threat?: string;
  engine?: string;
  version?: string;
}
export interface MalwareScanner {
  readonly name: string;
  scan(input: {
    stream: Readable;
    size: number;
    sha256: string;
    signal?: AbortSignal;
  }): Promise<ScanResult>;
}
export type ScannerUnavailablePolicy = 'warn-and-allow' | 'quarantine' | 'reject';

export interface ProcessorOutput {
  name: string;
  contentType: string;
  stream: Readable;
  metadata?: Readonly<Record<string, unknown>>;
}
export interface FileProcessorContext {
  file: FileRecord;
  openStream(): Promise<Readable>;
  signal?: AbortSignal;
}
export interface FileProcessor {
  readonly name: string;
  readonly version?: string;
  supports(context: FileProcessorContext): boolean;
  process(context: FileProcessorContext): Promise<readonly ProcessorOutput[]>;
}

export interface AuthorizationRequest {
  principal: AccessPrincipal | null;
  action: FileAction;
  resource: FileRecord;
  context?: Readonly<Record<string, unknown>>;
}
export interface AuthorizationDecision {
  allowed: boolean;
  reasonCode: string;
  policyVersion?: string;
}
export interface FileAuthorizer {
  authorize(request: AuthorizationRequest): Promise<AuthorizationDecision>;
}

export interface FileStorageLogger {
  debug(message: string, context?: Readonly<Record<string, unknown>>): void;
  info(message: string, context?: Readonly<Record<string, unknown>>): void;
  warn(message: string, context?: Readonly<Record<string, unknown>>): void;
  error(message: string, context?: Readonly<Record<string, unknown>>): void;
}
export interface FileStorageEvent {
  id: string;
  type: string;
  fileId?: string;
  occurredAt: Date;
  data: Readonly<Record<string, unknown>>;
}
export interface FileEventSink {
  publish(event: FileStorageEvent): Promise<void>;
}
