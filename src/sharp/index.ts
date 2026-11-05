import sharp from 'sharp';
import { z } from 'zod';
import type { FileProcessor, FileProcessorContext, ProcessorOutput } from '../contracts.js';

const variantSchema = z.object({
  width: z.number().int().positive().max(12_000),
  height: z.number().int().positive().max(12_000),
  fit: z.enum(['cover', 'contain', 'fill', 'inside', 'outside']).default('inside'),
  format: z.enum(['jpeg', 'png', 'webp', 'avif']).default('webp'),
  quality: z.number().int().min(1).max(100).default(80),
  withoutEnlargement: z.boolean().default(true),
});
export type ImageVariantSpec = z.input<typeof variantSchema>;
export interface SharpImageProcessorOptions {
  presets: Readonly<Record<string, Readonly<Record<string, ImageVariantSpec>>>>;
  maxInputPixels?: number;
}

export class SharpImageProcessor implements FileProcessor {
  readonly name = 'sharp-image-variants';
  readonly version = '1';
  private readonly maxInputPixels: number;
  constructor(private readonly options: SharpImageProcessorOptions) {
    this.maxInputPixels = options.maxInputPixels ?? 40_000_000;
  }
  supports({ file }: FileProcessorContext) {
    return (
      file.contentType.startsWith('image/') &&
      file.contentType !== 'image/svg+xml' &&
      Boolean(file.purpose && this.options.presets[file.purpose])
    );
  }
  async process(context: FileProcessorContext): Promise<readonly ProcessorOutput[]> {
    const preset = context.file.purpose ? this.options.presets[context.file.purpose] : undefined;
    if (!preset) return [];
    const input = await context.openStream();
    const chunks: Buffer[] = [];
    for await (const chunk of input)
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    const source = Buffer.concat(chunks);
    const metadata = await sharp(source, { limitInputPixels: this.maxInputPixels }).metadata();
    const outputs: ProcessorOutput[] = [];
    for (const [name, rawSpec] of Object.entries(preset)) {
      const spec = variantSchema.parse(rawSpec);
      let pipeline = sharp(source, { limitInputPixels: this.maxInputPixels }).rotate().resize({
        width: spec.width,
        height: spec.height,
        fit: spec.fit,
        withoutEnlargement: spec.withoutEnlargement,
      });
      if (spec.format === 'jpeg') pipeline = pipeline.jpeg({ quality: spec.quality });
      else if (spec.format === 'png') pipeline = pipeline.png({ quality: spec.quality });
      else if (spec.format === 'avif') pipeline = pipeline.avif({ quality: spec.quality });
      else pipeline = pipeline.webp({ quality: spec.quality });
      const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
      outputs.push({
        name,
        contentType: `image/${spec.format}`,
        stream: (await import('node:stream')).Readable.from(data),
        metadata: {
          width: info.width,
          height: info.height,
          format: info.format,
          sourceWidth: metadata.width,
          sourceHeight: metadata.height,
        },
      });
    }
    return outputs;
  }
}
