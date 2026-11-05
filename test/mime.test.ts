import { describe, expect, it } from 'vitest';
import { detectContentType } from '../src/index.js';

describe('detectContentType', () => {
  it.each([
    [Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg'],
    [Buffer.from('%PDF-1.7'), 'application/pdf'],
    [Buffer.from('OggS'), 'audio/ogg'],
  ])('detects signatures', (input, expected) => expect(detectContentType(input)).toBe(expected));
});
