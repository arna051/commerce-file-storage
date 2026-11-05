import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ClamAvScanner } from '../src/clamav/index.js';

const enabled = process.env.RUN_CLAMAV_INTEGRATION === '1';
describe.skipIf(!enabled)('ClamAvScanner integration', () => {
  const scanner = new ClamAvScanner({
    host: process.env.CLAMAV_HOST ?? '127.0.0.1',
    port: Number(process.env.CLAMAV_PORT ?? 3310),
  });
  it('recognizes a clean stream', async () => {
    const bytes = Buffer.from('hello');
    await expect(
      scanner.scan({ stream: Readable.from(bytes), size: bytes.length, sha256: 'unused' }),
    ).resolves.toMatchObject({ status: 'clean' });
  });
  it('recognizes the standard EICAR test signature', async () => {
    const bytes = Buffer.from(
      'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
    );
    await expect(
      scanner.scan({ stream: Readable.from(bytes), size: bytes.length, sha256: 'unused' }),
    ).resolves.toMatchObject({ status: 'infected' });
  });
});
