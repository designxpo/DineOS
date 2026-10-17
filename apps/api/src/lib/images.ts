/** An uploaded image's real type, from its first bytes; the browser's claimed type is ignored. */
export interface DetectedImage {
  ext: 'jpg' | 'png' | 'webp';
  contentType: 'image/jpeg' | 'image/png' | 'image/webp';
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * JPEG, PNG or WebP by file signature, or null for anything else (HTML, SVG, scripts, PDFs...),
 * whatever name or Content-Type it was sent with.
 */
export function detectImage(body: Buffer): DetectedImage | null {
  if (body.length < 12) return null;
  if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return { ext: 'jpg', contentType: 'image/jpeg' };
  if (body.subarray(0, 8).equals(PNG)) return { ext: 'png', contentType: 'image/png' };
  if (body.toString('latin1', 0, 4) === 'RIFF' && body.toString('latin1', 8, 12) === 'WEBP') return { ext: 'webp', contentType: 'image/webp' };
  return null;
}
