import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { MAX_RECEIPT_BYTES, checkReceiptFile, safeFilename } from './files';

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));
const pad = (head: number[], length = 64): Uint8Array => {
  const bytes = new Uint8Array(length);
  bytes.set(head);
  return bytes;
};

const JPEG = pad([0xff, 0xd8, 0xff, 0xe0]);
const PNG = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF = pad(ascii('%PDF-1.4\n'));
const GIF = pad(ascii('GIF89a'));
const WEBP = pad([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP')]);
const HEIC = pad([0, 0, 0, 0x18, ...ascii('ftypheic')]);

describe('checkReceiptFile', () => {
  it.each([
    ['JPEG', JPEG, 'image/jpeg', 'jpg'],
    ['PNG', PNG, 'image/png', 'png'],
    ['PDF', PDF, 'application/pdf', 'pdf'],
    ['GIF', GIF, 'image/gif', 'gif'],
    ['WebP', WEBP, 'image/webp', 'webp'],
  ])('accepts a %s by what it is, not what it is called', (_name, bytes, mediaType, extension) => {
    const result = checkReceiptFile(bytes);

    expect(result).toEqual({
      ok: true,
      mediaType,
      extension,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  });

  it('gives the same hash to the same bytes and a different one to different bytes', () => {
    const a = checkReceiptFile(JPEG);
    const b = checkReceiptFile(new Uint8Array(JPEG));
    const c = checkReceiptFile(PNG);

    expect(a.ok && b.ok && c.ok).toBe(true);
    if (a.ok && b.ok && c.ok) {
      expect(a.sha256).toBe(b.sha256);
      expect(a.sha256).not.toBe(c.sha256);
    }
  });

  it('turns an iPhone HEIC photo away with words that say what to do', () => {
    const result = checkReceiptFile(HEIC);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/HEIC.*JPEG/i);
  });

  it('refuses something that is not a receipt file', () => {
    const result = checkReceiptFile(pad(ascii('hello, this is text')));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/photo|PDF/i);
  });

  it('refuses an empty file', () => {
    const result = checkReceiptFile(new Uint8Array(0));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/empty/i);
  });

  it('refuses a file over the size limit, even if it looks like a photo', () => {
    const big = new Uint8Array(MAX_RECEIPT_BYTES + 1);
    big.set(JPEG.subarray(0, 4));

    const result = checkReceiptFile(big);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/10 MB/);
  });
});

describe('safeFilename', () => {
  it('keeps a plain name', () => {
    expect(safeFilename('receipt.pdf', 'receipt')).toBe('receipt.pdf');
  });

  it('drops any path and replaces awkward characters', () => {
    expect(safeFilename('C:\\Users\\me\\My Receipt (1).PDF', 'receipt')).toBe('My_Receipt__1_.PDF');
    expect(safeFilename('../../etc/passwd', 'receipt')).toBe('passwd');
  });

  it('falls back when nothing usable is left, and caps the length', () => {
    expect(safeFilename('///', 'receipt')).toBe('receipt');
    expect(safeFilename(`${'a'.repeat(200)}.jpg`, 'receipt').length).toBeLessThanOrEqual(80);
  });
});
