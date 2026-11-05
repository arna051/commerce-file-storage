import { once } from 'node:events';
import { Socket } from 'node:net';
import type { MalwareScanner, ScanResult } from '../contracts.js';
import { FileStorageError } from '../errors.js';

export interface ClamAvScannerOptions {
  host?: string;
  port?: number;
  timeoutMs?: number;
  maxStreamLength?: number;
}
export class ClamAvScanner implements MalwareScanner {
  readonly name = 'clamav';
  constructor(private readonly options: ClamAvScannerOptions = {}) {}
  async scan(input: Parameters<MalwareScanner['scan']>[0]): Promise<ScanResult> {
    const max = this.options.maxStreamLength ?? 40 * 1024 * 1024;
    if (input.size > max)
      throw new FileStorageError(
        'SCAN_UNAVAILABLE',
        `File exceeds configured ClamAV stream limit of ${max} bytes`,
      );
    const socket = new Socket();
    const timer = setTimeout(
      () => socket.destroy(new Error('ClamAV scan timed out')),
      this.options.timeoutMs ?? 30_000,
    );
    const abort = () => socket.destroy(new Error('ClamAV scan aborted'));
    input.signal?.addEventListener('abort', abort, { once: true });
    try {
      socket.connect(this.options.port ?? 3310, this.options.host ?? '127.0.0.1');
      await once(socket, 'connect');
      socket.write('zINSTREAM\0');
      let sent = 0;
      for await (const raw of input.stream) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
        sent += chunk.length;
        if (sent > max)
          throw new FileStorageError('SCAN_UNAVAILABLE', 'ClamAV stream limit exceeded');
        const size = Buffer.allocUnsafe(4);
        size.writeUInt32BE(chunk.length);
        if (!socket.write(Buffer.concat([size, chunk]))) await once(socket, 'drain');
      }
      if (sent !== input.size)
        throw new FileStorageError('SCAN_UNAVAILABLE', 'ClamAV input size did not match metadata');
      socket.end(Buffer.alloc(4));
      const chunks: Buffer[] = [];
      let responseSize = 0;
      for await (const raw of socket) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
        responseSize += chunk.length;
        if (responseSize > 1024)
          throw new FileStorageError('SCAN_UNAVAILABLE', 'ClamAV response exceeded safe limit');
        chunks.push(chunk);
        if (chunk.includes(0)) break;
      }
      const response = Buffer.concat(chunks).toString('utf8').replace(/\0.*$/s, '');
      if (/FOUND$/.test(response))
        return {
          status: 'infected',
          threat: response.replace(/^.*?:\s*/, '').replace(/\s+FOUND$/, ''),
          engine: 'clamav',
        };
      if (/OK$/.test(response)) return { status: 'clean', engine: 'clamav' };
      throw new FileStorageError('SCAN_UNAVAILABLE', 'ClamAV returned an unexpected response');
    } catch (error) {
      input.stream.destroy();
      socket.destroy();
      if (error instanceof FileStorageError) throw error;
      throw new FileStorageError('SCAN_UNAVAILABLE', 'ClamAV is unavailable', {
        cause: error,
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', abort);
    }
  }
}
