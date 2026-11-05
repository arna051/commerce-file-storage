import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { FILE_STORAGE, FileStorageModule, InjectFileStorage } from '../src/nestjs/index.js';
import type { FileStorage } from '../src/storage.js';
import { MemoryBlobProvider, MemoryMetadataStore } from '../src/testing/index.js';

describe('FileStorageModule', () => {
  it('registers the storage facade with forRoot', async () => {
    expect(typeof InjectFileStorage()).toBe('function');
    const module = await Test.createTestingModule({
      imports: [
        FileStorageModule.forRoot({
          provider: new MemoryBlobProvider(),
          metadata: new MemoryMetadataStore(),
          logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }),
      ],
    }).compile();
    expect(module.get<FileStorage>(FILE_STORAGE)).toBeDefined();
    await module.close();
  });

  it('registers the storage facade with forRootAsync', async () => {
    const module = await Test.createTestingModule({
      imports: [
        FileStorageModule.forRootAsync({
          useFactory: () => ({
            provider: new MemoryBlobProvider(),
            metadata: new MemoryMetadataStore(),
            logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          }),
        }),
      ],
    }).compile();
    expect(typeof module.get<FileStorage>(FILE_STORAGE).upload).toBe('function');
    await module.close();
  });
});
