export function detectContentType(bytes: Uint8Array): string | undefined {
  const is = (...signature: number[]) => signature.every((value, index) => bytes[index] === value);
  if (is(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (is(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (is(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (is(0x25, 0x50, 0x44, 0x46)) return 'application/pdf';
  if (is(0x50, 0x4b, 0x03, 0x04)) return 'application/zip';
  const ascii = Buffer.from(bytes.subarray(0, 32)).toString('ascii');
  if (/^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(ascii)) return 'image/svg+xml';
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'image/webp';
  if (ascii.slice(4, 8) === 'ftyp') {
    const brand = ascii.slice(8, 12);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (brand.startsWith('M4A')) return 'audio/mp4';
    return 'video/mp4';
  }
  if (is(0x49, 0x44, 0x33) || is(0xff, 0xfb) || is(0xff, 0xf3) || is(0xff, 0xf2))
    return 'audio/mpeg';
  if (is(0x4f, 0x67, 0x67, 0x53)) return 'audio/ogg';
  if (is(0x66, 0x4c, 0x61, 0x43)) return 'audio/flac';
  return undefined;
}
