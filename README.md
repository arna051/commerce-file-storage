# commerce-file-storage

Server-side TypeScript file storage for ecommerce applications. It stores immutable bytes in MinIO or another S3-compatible service and searchable lifecycle metadata in an optional Mongoose adapter. Core contracts do not expose AWS, MongoDB, or NestJS types.

## Features

- Streamed uploads and downloads with byte limits and SHA-256 hashing
- Retryable, persistent S3 multipart uploads
- Seven-day temporary files with safe promotion to permanent retention
- Private-by-default access with user, group, role, and service grants
- Optional ClamAV scanning with explicit `warn-and-allow`, `quarantine`, or `reject` behavior
- Sharp image variants selected by file purpose
- Extensible MIME/purpose processors
- Optional NestJS `forRoot` and `forRootAsync`
- ESM, CommonJS, and declarations; Node.js 20+

## Install

```sh
npm install commerce-file-storage zod @aws-sdk/client-s3 @aws-sdk/s3-request-presigner mongoose
npm install sharp # when image variants are enabled
```

## Infrastructure

`docker compose up -d` starts MongoDB, builds MinIO Community from a pinned official source commit, creates a versioned `commerce-files` bucket, and starts ClamAV. MinIO Community became source-only, so the stack does not depend on an abandoned third-party binary image. Compose credentials are development-only. In production, review and update the pinned source commit, use restricted MinIO application credentials, keep the console and ClamAV private, enable TLS, alert on disk capacity, and maintain a tested off-site backup.

## Node usage

```ts
import mongoose from 'mongoose';
import { createFileStorage, MongooseAclAuthorizer } from 'commerce-file-storage';
import { S3StorageProvider } from 'commerce-file-storage/s3';
import { MongooseMetadataStore } from 'commerce-file-storage/mongoose';
import { ClamAvScanner } from 'commerce-file-storage/clamav';
import { SharpImageProcessor } from 'commerce-file-storage/sharp';

const connection = await mongoose.createConnection(process.env.MONGODB_URI!).asPromise();
const metadata = new MongooseMetadataStore({ connection });
await metadata.ensureIndexes();

const provider = new S3StorageProvider({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION ?? 'us-east-1',
  bucket: process.env.S3_BUCKET!,
  accessKeyId: process.env.S3_ACCESS_KEY_ID!,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
  forcePathStyle: true,
});

export const files = createFileStorage({
  provider,
  metadata,
  authorizer: new MongooseAclAuthorizer(metadata),
  scanner: new ClamAvScanner({ host: 'clamav', port: 3310 }),
  scannerUnavailablePolicy: 'warn-and-allow',
  processors: [
    new SharpImageProcessor({
      presets: {
        'product-image': {
          thumbnail: { width: 160, height: 160, fit: 'cover', format: 'webp', quality: 75 },
          card: { width: 640, height: 640, fit: 'inside', format: 'webp', quality: 80 },
          detail: { width: 1200, height: 1200, fit: 'inside', format: 'webp', quality: 82 },
        },
      },
    }),
  ],
});
```

Upload a server stream without buffering the entire file:

```ts
const file = await files.upload({
  namespace: 'business/business-1',
  stream: request,
  filename: 'shoe.jpg',
  contentType: request.headers['content-type'] ?? 'application/octet-stream',
  contentLength: Number(request.headers['content-length']),
  purpose: 'product-image',
  access: { mode: 'restricted', owner: { type: 'user', id: user.id }, policyVersion: 1 },
});
```

## Resumable server-side multipart uploads

Create an intent with a stable idempotency key, upload numbered parts, reconcile after a crash, then complete:

```ts
const session = await files.createMultipartUpload({
  namespace: 'business/business-1',
  contentType: 'application/pdf',
  contentLength: totalBytes,
  idempotencyKey: requestId,
});
await files.uploadPart(session.id, 1, firstPartStream, firstPartLength);
const resumed = await files.resumeMultipartUpload(session.id);
const completed = await files.completeMultipartUpload(resumed.id);
```

S3 requires all non-final parts to be at least 5 MiB. A live HTTP request cannot magically resume after the client loses its source; the caller must retain a seekable source and resend missing part numbers.

## Temporary files

Uploads are permanent by default. Mark an upload as temporary to give it a seven-day lifetime;
set `temporaryFileTtlMs` on `createFileStorage` to change the default, or provide an explicit
`expiresAt` for one file. Multipart uploads support the same `retention` input.

```ts
const temporary = await files.upload({
  namespace: 'business/business-1',
  stream: request,
  contentType: 'image/jpeg',
  contentLength,
  retention: { mode: 'temporary' },
});

// Keep it after the user attaches it to a permanent business record.
await files.markPermanent(temporary.id, actor);

// Run from a trusted scheduled job. Defaults to now and a batch size of 100.
await files.cleanupExpiredTemporaryFiles({ limit: 500 });
```

Cleanup first claims the expired record, then deletes its object, and only then marks its metadata
permanently deleted. A failed object deletion remains recoverably soft-deleted for the existing
purge job. Do not configure a MongoDB TTL index for file records: MongoDB cannot delete the MinIO
object and would create orphaned bytes.

## Authorization

The package uses principal/action/resource/context semantics. The host must authenticate requests and pass a verified principal. Missing authorization adapters mean trusted-server mode, so applications exposing user requests should configure an authorizer.

```ts
const actor = { type: 'user' as const, id: user.id, groups: user.groupIds, roles: user.roles };
await files.grantAccess(file.id, actor, {
  principal: { type: 'group', id: 'catalog-team' },
  actions: ['read', 'download'],
});
const url = await files.createSignedDownload(file.id, actor, 300);
```

Signed URLs are bearer capabilities and cannot be revoked before expiry. Keep expirations short and never log them.

## Scanner behavior

When ClamAV is omitted, the package emits a startup warning. When configured but unavailable, `warn-and-allow` records `scanStatus: 'skipped-unavailable'`; it never records the file as clean. Use `quarantine` or `reject` for stricter deployments. Keep port 3310 private and configure ClamAV `StreamMaxLength` above the package maximum file size.

## Custom processors

Uploads are identified from their bytes rather than trusted client headers. Set
`allowedContentTypes` to exact values such as `application/pdf` or wildcards such as
`image/*`. SVG is rejected by default because it can contain active content; only set
`rejectSvg: false` when the application sanitizes SVG and serves it with an appropriate
content security policy.

Implement `FileProcessor`. `supports` can select by detected MIME type, purpose, or metadata. Processors receive an immutable read stream and return named output streams; they never receive storage credentials. Outputs become immutable child file records. Raw user strings must never be converted into shell arguments.

## NestJS

```ts
import { FileStorageModule } from 'commerce-file-storage/nestjs';

@Module({
  imports: [
    FileStorageModule.forRootAsync({
      inject: [ConfigService],
      useFactory: async (config) => ({ provider, metadata }),
    }),
  ],
})
export class AppModule {}
```

Inject with `@InjectFileStorage()`. The module deliberately registers no public controller: authentication, rate limits, routes, and request parsing belong to the application.

## Consistency and cleanup

MongoDB and S3 do not share a transaction. Records use explicit pending/finalizing/available/failed states and optimistic updates. Applications should schedule reconciliation of expired upload sessions, temporary files, and soft-deleted objects. Bucket versioning and delayed physical deletion are recommended. Never treat bucket listings as the metadata database.

## License

MIT
