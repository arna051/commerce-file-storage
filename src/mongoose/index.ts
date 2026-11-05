import { Schema, type Connection, type Model } from 'mongoose';
import type {
  FileGrant,
  FileRecord,
  MetadataStore,
  PrincipalRef,
  UploadSession,
} from '../contracts.js';
import { FileStorageError } from '../errors.js';

export interface MongooseMetadataStoreOptions {
  connection: Connection;
  collectionPrefix?: string;
}

type FileDocument = FileRecord & { _id: string };
type UploadDocument = UploadSession & { _id: string };
type GrantDocument = FileGrant & { _id: string };

function fileSchema() {
  return new Schema<FileDocument>(
    {
      _id: { type: String, required: true },
      id: { type: String, required: true, unique: true },
      namespace: { type: String, required: true, index: true },
      storageTarget: { type: String, required: true },
      objectKey: { type: String, required: true, unique: true },
      originalFilename: String,
      declaredContentType: String,
      contentType: { type: String, required: true },
      size: { type: Number, required: true },
      sha256: { type: String, required: false, default: '' },
      purpose: { type: String, index: true },
      lifecycleStatus: { type: String, required: true, index: true },
      scanStatus: { type: String, required: true, index: true },
      processingStatus: { type: String, required: true, index: true },
      retention: {
        mode: { type: String, required: true, default: 'permanent' },
        expiresAt: Date,
      },
      access: {
        mode: { type: String, required: true, index: true },
        owner: { type: { type: String }, id: { type: String } },
        policyVersion: { type: Number, required: true },
      },
      references: [{ _id: false, type: String, id: String, role: String }],
      variants: [
        { _id: false, name: String, fileId: String, width: Number, height: Number, format: String },
      ],
      metadata: { type: Schema.Types.Mixed, required: true, default: {} },
      createdAt: { type: Date, required: true },
      updatedAt: { type: Date, required: true },
      deletedAt: Date,
    },
    { versionKey: false, strict: 'throw' },
  )
    .index({ namespace: 1, lifecycleStatus: 1, createdAt: -1 })
    .index({ 'retention.mode': 1, 'retention.expiresAt': 1, lifecycleStatus: 1 });
}

function uploadSchema() {
  return new Schema<UploadDocument>(
    {
      _id: { type: String, required: true },
      id: { type: String, required: true, unique: true },
      fileId: { type: String, required: true, index: true },
      idempotencyKey: { type: String, required: true },
      namespace: { type: String, required: true, index: true },
      storageTarget: { type: String, required: true },
      objectKey: { type: String, required: true },
      providerUploadId: { type: String, required: true },
      status: { type: String, required: true, index: true },
      expectedSize: { type: Number, required: true },
      partSize: { type: Number, required: true },
      contentType: { type: String, required: true },
      filename: String,
      purpose: String,
      access: {
        mode: { type: String, required: true },
        owner: { type: { type: String }, id: { type: String } },
        policyVersion: { type: Number, required: true },
      },
      retention: {
        mode: { type: String, required: true, default: 'permanent' },
        expiresAt: Date,
      },
      parts: [
        { _id: false, partNumber: Number, etag: String, size: Number, checksumSha256: String },
      ],
      expiresAt: { type: Date, required: true, index: true },
      createdAt: { type: Date, required: true },
      updatedAt: { type: Date, required: true },
    },
    { versionKey: false, strict: 'throw' },
  )
    .index({ status: 1, expiresAt: 1 })
    .index({ namespace: 1, idempotencyKey: 1 }, { unique: true });
}

function grantSchema() {
  return new Schema<GrantDocument>(
    {
      _id: { type: String, required: true },
      id: { type: String, required: true, unique: true },
      fileId: { type: String, required: true, index: true },
      principal: { type: { type: String, required: true }, id: { type: String, required: true } },
      actions: [{ type: String, required: true }],
      expiresAt: { type: Date, index: true },
      createdAt: { type: Date, required: true },
    },
    { versionKey: false, strict: 'throw' },
  ).index({ fileId: 1, 'principal.type': 1, 'principal.id': 1 }, { unique: true });
}

function plain<T>(value: unknown): T {
  const record = value as { toObject?: () => unknown };
  const output = record.toObject ? record.toObject() : value;
  const rest = { ...(output as Record<string, unknown>) };
  delete rest._id;
  if (
    !rest.retention &&
    (typeof rest.lifecycleStatus === 'string' || typeof rest.providerUploadId === 'string')
  )
    rest.retention = { mode: 'permanent' };
  return rest as T;
}

export class MongooseMetadataStore implements MetadataStore {
  readonly fileModel: Model<FileDocument>;
  readonly uploadModel: Model<UploadDocument>;
  readonly grantModel: Model<GrantDocument>;

  constructor(options: MongooseMetadataStoreOptions) {
    const prefix = options.collectionPrefix ?? 'commerce_file_storage';
    const suffix = prefix.replace(/[^a-zA-Z0-9_]/g, '_');
    this.fileModel = options.connection.model<FileDocument>(
      `${suffix}_File`,
      fileSchema(),
      `${prefix}_files`,
    );
    this.uploadModel = options.connection.model<UploadDocument>(
      `${suffix}_Upload`,
      uploadSchema(),
      `${prefix}_uploads`,
    );
    this.grantModel = options.connection.model<GrantDocument>(
      `${suffix}_Grant`,
      grantSchema(),
      `${prefix}_grants`,
    );
  }

  async ensureIndexes(): Promise<void> {
    await Promise.all([
      this.fileModel.createIndexes(),
      this.uploadModel.createIndexes(),
      this.grantModel.createIndexes(),
    ]);
  }
  async createFile(file: FileRecord) {
    return plain<FileRecord>(await this.fileModel.create({ ...file, _id: file.id }));
  }
  async getFile(id: string) {
    const value = await this.fileModel.findOne({ id }).lean();
    return value ? plain<FileRecord>(value) : null;
  }
  async updateFile(id: string, expectedUpdatedAt: Date, patch: Partial<FileRecord>) {
    const value = await this.fileModel
      .findOneAndUpdate(
        { id, updatedAt: expectedUpdatedAt },
        { $set: patch },
        { returnDocument: 'after', runValidators: true },
      )
      .lean();
    if (!value)
      throw new FileStorageError('METADATA_ERROR', 'Concurrent file metadata update detected', {
        retryable: true,
      });
    return plain<FileRecord>(value);
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
    const filter: Record<string, unknown> = {};
    if (query.lifecycleStatus) filter.lifecycleStatus = query.lifecycleStatus;
    if (query.lifecycleStatuses) filter.lifecycleStatus = { $in: query.lifecycleStatuses };
    if (query.deletedBefore) filter.deletedAt = { $lte: query.deletedBefore };
    if (query.expiresBefore) filter['retention.expiresAt'] = { $lte: query.expiresBefore };
    if (query.retentionMode) filter['retention.mode'] = query.retentionMode;
    if (query.namespace) filter.namespace = query.namespace;
    const values = await this.fileModel
      .find(filter)
      .sort({ updatedAt: 1 })
      .limit(query.limit)
      .lean();
    return values.map((value) => plain<FileRecord>(value));
  }
  async createUpload(session: UploadSession) {
    return plain<UploadSession>(await this.uploadModel.create({ ...session, _id: session.id }));
  }
  async getUpload(id: string) {
    const value = await this.uploadModel.findOne({ id }).lean();
    return value ? plain<UploadSession>(value) : null;
  }
  async findUploadByIdempotencyKey(namespace: string, idempotencyKey: string) {
    const value = await this.uploadModel.findOne({ namespace, idempotencyKey }).lean();
    return value ? plain<UploadSession>(value) : null;
  }
  async updateUpload(id: string, expectedUpdatedAt: Date, patch: Partial<UploadSession>) {
    const value = await this.uploadModel
      .findOneAndUpdate(
        { id, updatedAt: expectedUpdatedAt },
        { $set: patch },
        { returnDocument: 'after', runValidators: true },
      )
      .lean();
    if (!value)
      throw new FileStorageError('METADATA_ERROR', 'Concurrent upload metadata update detected', {
        retryable: true,
      });
    return plain<UploadSession>(value);
  }
  async listExpiredUploads(before: Date, limit: number) {
    const values = await this.uploadModel
      .find({ expiresAt: { $lt: before }, status: { $in: ['initiated', 'uploading', 'failed'] } })
      .sort({ expiresAt: 1 })
      .limit(limit)
      .lean();
    return values.map((value) => plain<UploadSession>(value));
  }
  async listGrants(fileId: string) {
    const values = await this.grantModel.find({ fileId }).lean();
    return values.map((value) => plain<FileGrant>(value));
  }
  async putGrant(grant: FileGrant) {
    const value = await this.grantModel
      .findOneAndUpdate(
        {
          fileId: grant.fileId,
          'principal.type': grant.principal.type,
          'principal.id': grant.principal.id,
        },
        { $set: grant, $setOnInsert: { _id: grant.id } },
        { upsert: true, returnDocument: 'after', runValidators: true },
      )
      .lean();
    return plain<FileGrant>(value);
  }
  async revokeGrant(fileId: string, principal: PrincipalRef) {
    await this.grantModel.deleteOne({
      fileId,
      'principal.type': principal.type,
      'principal.id': principal.id,
    });
  }
}
