import { Readable } from 'node:stream';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { createFileStorage } from '../src/index.js';
import { SharpImageProcessor } from '../src/sharp/index.js';
import { MemoryBlobProvider, MemoryMetadataStore } from '../src/testing/index.js';

describe('SharpImageProcessor', () => {
  it('creates immutable named variants and strips source metadata', async () => {
    const source = await sharp({
      create: { width: 800, height: 600, channels: 3, background: '#cc3300' },
    })
      .jpeg()
      .withExif({ IFD0: { Copyright: 'private metadata' } })
      .toBuffer();
    const provider = new MemoryBlobProvider();
    const metadata = new MemoryMetadataStore();
    const storage = createFileStorage({
      provider,
      metadata,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      processors: [
        new SharpImageProcessor({
          presets: {
            'product-image': {
              thumbnail: {
                width: 160,
                height: 160,
                fit: 'cover',
                format: 'webp',
                quality: 75,
              },
            },
          },
        }),
      ],
    });
    const file = await storage.upload({
      namespace: 'business/1',
      stream: Readable.from(source),
      contentType: 'image/jpeg',
      contentLength: source.length,
      purpose: 'product-image',
    });
    expect(file.processingStatus).toBe('completed');
    expect(file.variants).toHaveLength(1);
    const variant = await metadata.getFile(file.variants[0]!.fileId);
    expect(variant?.contentType).toBe('image/webp');
    expect(typeof variant?.size).toBe('number');
    const object = provider.objects.get(variant!.objectKey)!;
    const output = await sharp(object.data).metadata();
    expect(output).toMatchObject({ format: 'webp', width: 160, height: 160 });
    expect(output.exif).toBeUndefined();
  });
});
