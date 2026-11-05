import { z } from 'zod';

const safeId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[\p{L}\p{N}._:@/-]+$/u);
export const principalRefSchema = z.object({
  type: z.enum(['user', 'group', 'role', 'service']),
  id: safeId,
});
export const fileAccessSchema = z.object({
  mode: z.enum(['public', 'authenticated', 'restricted']).default('restricted'),
  owner: principalRefSchema.optional(),
  policyVersion: z.number().int().positive().default(1),
});
export const fileRetentionSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('permanent') }),
  z.object({ mode: z.literal('temporary'), expiresAt: z.date().optional() }),
]);
export const uploadInputSchema = z.object({
  namespace: safeId,
  filename: z.string().trim().min(1).max(512).optional(),
  contentType: z.string().trim().min(1).max(255),
  contentLength: z.number().int().positive(),
  purpose: safeId.optional(),
  access: fileAccessSchema.optional(),
  retention: fileRetentionSchema.default({ mode: 'permanent' }),
  metadata: z.record(z.string(), z.unknown()).default({}),
  references: z
    .array(z.object({ type: safeId, id: safeId, role: safeId.optional() }))
    .max(100)
    .default([]),
});
export const multipartInputSchema = uploadInputSchema.extend({
  idempotencyKey: z.string().min(8).max(256),
  partSize: z
    .number()
    .int()
    .min(5 * 1024 * 1024)
    .optional(),
});
export const fileStorageOptionsSchema = z.object({
  storageTarget: safeId.default('default'),
  maxFileSize: z
    .number()
    .int()
    .positive()
    .default(40 * 1024 * 1024),
  multipartPartSize: z
    .number()
    .int()
    .min(5 * 1024 * 1024)
    .default(8 * 1024 * 1024),
  uploadSessionTtlMs: z
    .number()
    .int()
    .positive()
    .default(24 * 60 * 60 * 1000),
  temporaryFileTtlMs: z
    .number()
    .int()
    .positive()
    .default(7 * 24 * 60 * 60 * 1000),
  signedUrlMaxExpirySeconds: z
    .number()
    .int()
    .positive()
    .max(7 * 24 * 3600)
    .default(3600),
  scannerUnavailablePolicy: z
    .enum(['warn-and-allow', 'quarantine', 'reject'])
    .default('warn-and-allow'),
  allowedContentTypes: z.array(z.string().min(1)).optional(),
  rejectSvg: z.boolean().default(true),
});
