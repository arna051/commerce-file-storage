import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'node:stream';
import { z } from 'zod';
import type { BlobProvider, MultipartPart, PutBlobInput } from '../contracts.js';
import { FileStorageError } from '../errors.js';

export const s3StorageProviderConfigSchema = z.object({
  bucket: z.string().min(1),
  endpoint: z.url().optional(),
  region: z.string().min(1).default('us-east-1'),
  accessKeyId: z.string().min(1).optional(),
  secretAccessKey: z.string().min(1).optional(),
  forcePathStyle: z.boolean().default(true),
  prefix: z.string().default(''),
});
export type S3StorageProviderConfig = z.input<typeof s3StorageProviderConfigSchema> & {
  client?: S3Client;
};

export class S3StorageProvider implements BlobProvider {
  readonly capabilities = { multipart: true, signedDownloads: true, ranges: true } as const;
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;
  constructor(config: S3StorageProviderConfig) {
    const value = s3StorageProviderConfigSchema.parse(config);
    this.bucket = value.bucket;
    this.prefix = value.prefix;
    const clientConfig: S3ClientConfig = {
      region: value.region,
      forcePathStyle: value.forcePathStyle,
      ...(value.endpoint ? { endpoint: value.endpoint } : {}),
      ...(value.accessKeyId && value.secretAccessKey
        ? {
            credentials: { accessKeyId: value.accessKeyId, secretAccessKey: value.secretAccessKey },
          }
        : {}),
    };
    this.client = config.client ?? new S3Client(clientConfig);
  }
  private key(key: string) {
    return `${this.prefix}${key}`;
  }
  async put(input: PutBlobInput) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key(input.key),
        Body: input.body,
        ContentType: input.contentType,
        ContentLength: input.contentLength,
        Metadata: input.metadata,
      }),
      input.signal ? { abortSignal: input.signal } : {},
    );
    return (await this.head(input.key))!;
  }
  async getStream(
    key: string,
    options: { start?: number; end?: number; signal?: AbortSignal } = {},
  ) {
    const range =
      options.start !== undefined || options.end !== undefined
        ? `bytes=${options.start ?? ''}-${options.end ?? ''}`
        : undefined;
    const output = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.key(key),
        ...(range ? { Range: range } : {}),
      }),
      options.signal ? { abortSignal: options.signal } : {},
    );
    if (!output.Body)
      throw new FileStorageError('PROVIDER_ERROR', 'S3 returned an empty response body');
    return output.Body instanceof Readable
      ? output.Body
      : Readable.fromWeb(output.Body.transformToWebStream());
  }
  async head(key: string) {
    try {
      const out = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(key) }),
      );
      return {
        key,
        size: out.ContentLength ?? 0,
        ...(out.ContentType ? { contentType: out.ContentType } : {}),
        ...(out.ETag ? { etag: out.ETag.replaceAll('"', '') } : {}),
        ...(out.ChecksumSHA256 ? { checksumSha256: out.ChecksumSHA256 } : {}),
        ...(out.Metadata ? { metadata: out.Metadata } : {}),
      };
    } catch (error) {
      if ((error as { name?: string }).name === 'NotFound') return null;
      throw error;
    }
  }
  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(key) }));
  }
  async createMultipart(input: {
    key: string;
    contentType: string;
    metadata?: Readonly<Record<string, string>>;
  }) {
    const out = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: this.key(input.key),
        ContentType: input.contentType,
        Metadata: input.metadata,
      }),
    );
    if (!out.UploadId)
      throw new FileStorageError('PROVIDER_ERROR', 'S3 did not return an upload ID');
    return { uploadId: out.UploadId };
  }
  async uploadPart(input: {
    key: string;
    uploadId: string;
    partNumber: number;
    body: Readable;
    contentLength: number;
    signal?: AbortSignal;
  }) {
    const out = await this.client.send(
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: this.key(input.key),
        UploadId: input.uploadId,
        PartNumber: input.partNumber,
        Body: input.body,
        ContentLength: input.contentLength,
      }),
      input.signal ? { abortSignal: input.signal } : {},
    );
    if (!out.ETag) throw new FileStorageError('PROVIDER_ERROR', 'S3 did not return a part ETag');
    return {
      partNumber: input.partNumber,
      etag: out.ETag.replaceAll('"', ''),
      size: input.contentLength,
    };
  }
  async listParts(input: { key: string; uploadId: string }) {
    const parts: MultipartPart[] = [];
    let marker: string | undefined;
    do {
      const out = await this.client.send(
        new ListPartsCommand({
          Bucket: this.bucket,
          Key: this.key(input.key),
          UploadId: input.uploadId,
          ...(marker ? { PartNumberMarker: marker } : {}),
        }),
      );
      for (const part of out.Parts ?? [])
        if (part.PartNumber && part.ETag)
          parts.push({
            partNumber: part.PartNumber,
            etag: part.ETag.replaceAll('"', ''),
            ...(part.Size !== undefined ? { size: part.Size } : {}),
          });
      marker = out.IsTruncated ? out.NextPartNumberMarker : undefined;
    } while (marker);
    return parts;
  }
  async completeMultipart(input: {
    key: string;
    uploadId: string;
    parts: readonly MultipartPart[];
  }) {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: this.key(input.key),
        UploadId: input.uploadId,
        MultipartUpload: {
          Parts: input.parts.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
        },
      }),
    );
    const head = await this.head(input.key);
    if (!head) throw new FileStorageError('PROVIDER_ERROR', 'Completed S3 object cannot be found');
    return head;
  }
  async abortMultipart(input: { key: string; uploadId: string }) {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: this.key(input.key),
        UploadId: input.uploadId,
      }),
    );
  }
  async signDownload(input: { key: string; expiresInSeconds: number; filename?: string }) {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.key(input.key),
        ...(input.filename
          ? {
              ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(input.filename)}`,
            }
          : {}),
      }),
      { expiresIn: input.expiresInSeconds },
    );
  }
}
