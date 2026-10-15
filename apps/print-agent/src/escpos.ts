// Minimal ESC/POS encoder (Epson-compatible thermal printers). No dependencies.

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

/** Thermal printers use single-byte code pages; keep to ASCII and spell out the rupee sign. */
export function toAscii(text: string): string {
  return text
    .replace(/₹/g, 'Rs.')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]/g, '?');
}

export class EscPos {
  private bytes: number[] = [];
  /** Plain-text mirror of what was printed, for previews and tests. */
  readonly preview: string[] = [];
  private current = '';

  init(): this {
    this.bytes.push(ESC, 0x40);
    return this;
  }

  align(a: 'left' | 'center' | 'right'): this {
    this.bytes.push(ESC, 0x61, a === 'left' ? 0 : a === 'center' ? 1 : 2);
    return this;
  }

  bold(on: boolean): this {
    this.bytes.push(ESC, 0x45, on ? 1 : 0);
    return this;
  }

  /** Character magnification, 1 to 8 in each direction. */
  size(width: number, height: number): this {
    this.bytes.push(GS, 0x21, ((width - 1) << 4) | (height - 1));
    return this;
  }

  text(s: string): this {
    const ascii = toAscii(s);
    for (let i = 0; i < ascii.length; i++) this.bytes.push(ascii.charCodeAt(i));
    this.current += ascii;
    return this;
  }

  line(s = ''): this {
    this.text(s);
    this.bytes.push(LF);
    this.preview.push(this.current);
    this.current = '';
    return this;
  }

  feed(lines: number): this {
    this.bytes.push(ESC, 0x64, Math.max(0, Math.min(255, lines)));
    for (let i = 0; i < lines; i++) this.preview.push('');
    return this;
  }

  /** Feeds to the cutter and makes a partial cut. */
  cut(): this {
    this.bytes.push(GS, 0x56, 66, 0);
    this.preview.push('--- cut ---');
    return this;
  }

  /** QR code (model 2). `size` is the module size in dots, 1 to 16. */
  qr(data: string, size = 6): this {
    const payload = Buffer.from(data, 'utf8');
    const len = payload.length + 3;
    this.bytes.push(GS, 0x28, 0x6b, 4, 0, 0x31, 0x41, 0x32, 0x00); // model 2
    this.bytes.push(GS, 0x28, 0x6b, 3, 0, 0x31, 0x43, size); // module size
    this.bytes.push(GS, 0x28, 0x6b, 3, 0, 0x31, 0x45, 0x31); // error correction M
    this.bytes.push(GS, 0x28, 0x6b, len & 0xff, len >> 8, 0x31, 0x50, 0x30, ...payload); // store
    this.bytes.push(GS, 0x28, 0x6b, 3, 0, 0x31, 0x51, 0x30); // print
    this.preview.push(`[QR ${data}]`);
    return this;
  }

  build(): Buffer {
    return Buffer.from(this.bytes);
  }
}

/** "left ....... right" padded to `width`; the left side is truncated if needed. */
export function columns(left: string, right: string, width: number): string {
  const l = toAscii(left);
  const r = toAscii(right);
  const space = width - r.length - 1;
  const leftFit = l.length > space ? l.slice(0, Math.max(0, space)) : l;
  return leftFit + ' '.repeat(Math.max(1, width - leftFit.length - r.length)) + r;
}

/** Word-wraps text to `width` columns with an optional hanging indent. */
export function wrap(text: string, width: number, indent = ''): string[] {
  const words = toAscii(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const prefix = lines.length ? indent : '';
    if ((prefix + line + (line ? ' ' : '') + word).length > width && line) {
      lines.push(prefix + line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push((lines.length ? indent : '') + line);
  return lines.length ? lines : [''];
}
