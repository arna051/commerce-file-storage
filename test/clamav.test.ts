import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ClamAvScanner } from '../src/clamav/index.js';

describe('ClamAvScanner validation', () => {
  it('rejects metadata and streamed sizes above its configured limit before accepting a scan', async () => {
    const scanner = new ClamAvScanner({ maxStreamLength: 2, timeoutMs: 100 });
    await expect(
      scanner.scan({ stream: Readable.from('abc'), size: 3, sha256: '' }),
    ).rejects.toMatchObject({ code: 'SCAN_UNAVAILABLE' });
  });

  it('wraps connection failures as retryable scanner errors', async () => {
    const scanner = new ClamAvScanner({ port: 1, timeoutMs: 100 });
    await expect(
      scanner.scan({ stream: Readable.from('a'), size: 1, sha256: '' }),
    ).rejects.toMatchObject({ code: 'SCAN_UNAVAILABLE', retryable: true });
  });
});
