import { describe, expect, it } from 'vitest';
import { detectContentType } from '../src/index.js';

describe('detectContentType', () => {
  it.each([
    [Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg'],
    [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png'],
    [Buffer.from('GIF89a'), 'image/gif'],
    [Buffer.from('%PDF-1.7'), 'application/pdf'],
    [Buffer.from([0x50, 0x4b, 0x03, 0x04]), 'application/zip'],
    [Buffer.from('RIFFxxxxWEBP'), 'image/webp'],
    [Buffer.from('xxxxftypavif'), 'image/avif'],
    [Buffer.from('xxxxftypM4A '), 'audio/mp4'],
    [Buffer.from('xxxxftypisom'), 'video/mp4'],
    [Buffer.from('ID3'), 'audio/mpeg'],
    [Buffer.from('OggS'), 'audio/ogg'],
    [Buffer.from('fLaC'), 'audio/flac'],
    [Buffer.from('<?xml version="1.0"?><svg>'), 'image/svg+xml'],
  ])('detects signatures', (input, expected) => expect(detectContentType(input)).toBe(expected));

  it('returns undefined for unknown bytes', () => {
    expect(detectContentType(Buffer.from('plain text'))).toBeUndefined();
  });
});
