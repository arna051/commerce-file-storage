import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    's3/index': 'src/s3/index.ts',
    'mongoose/index': 'src/mongoose/index.ts',
    'clamav/index': 'src/clamav/index.ts',
    'sharp/index': 'src/sharp/index.ts',
    'nestjs/index': 'src/nestjs/index.ts',
    'testing/index': 'src/testing/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  external: [
    '@aws-sdk/client-s3',
    '@aws-sdk/s3-request-presigner',
    '@nestjs/common',
    '@nestjs/core',
    'mongoose',
    'reflect-metadata',
    'sharp',
  ],
});
