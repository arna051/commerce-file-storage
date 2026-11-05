export type FileStorageErrorCode =
  | 'INVALID_INPUT'
  | 'FILE_NOT_FOUND'
  | 'UPLOAD_NOT_FOUND'
  | 'UPLOAD_STATE_CONFLICT'
  | 'PROVIDER_ERROR'
  | 'METADATA_ERROR'
  | 'FILE_TOO_LARGE'
  | 'MIME_NOT_ALLOWED'
  | 'CHECKSUM_MISMATCH'
  | 'ACCESS_DENIED'
  | 'SCAN_INFECTED'
  | 'SCAN_UNAVAILABLE'
  | 'PROCESSING_FAILED'
  | 'UNSUPPORTED_OPERATION';

export class FileStorageError extends Error {
  readonly code: FileStorageErrorCode;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>> | undefined;
  override readonly cause: unknown;

  constructor(
    code: FileStorageErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      details?: Readonly<Record<string, unknown>>;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = 'FileStorageError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
    this.cause = options.cause;
  }
}

export function asFileStorageError(error: unknown, code: FileStorageErrorCode): FileStorageError {
  return error instanceof FileStorageError
    ? error
    : new FileStorageError(code, 'File storage operation failed', {
        cause: error,
        retryable: true,
      });
}
