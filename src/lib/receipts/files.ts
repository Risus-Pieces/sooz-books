import { createHash } from 'node:crypto';

/** The bucket's own limit, so the two never disagree. */
export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;

export const RECEIPT_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'] as const;
export type ReceiptMediaType = (typeof RECEIPT_MEDIA_TYPES)[number];

export type FileCheck =
  | { ok: true; mediaType: ReceiptMediaType; sha256: string; extension: string }
  | { ok: false; message: string };

const EXTENSION: Record<ReceiptMediaType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
};

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, i) => bytes[offset + i] === byte);
}

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));

const HEIC_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'];

function isHeic(bytes: Uint8Array): boolean {
  if (!startsWith(bytes, ascii('ftyp'), 4)) return false;
  const brand = String.fromCharCode(...bytes.subarray(8, 12));
  return HEIC_BRANDS.includes(brand);
}

/** What the bytes say the file is. The name and the browser's claim are never trusted. */
function sniff(bytes: Uint8Array): ReceiptMediaType | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, ascii('%PDF-'))) return 'application/pdf';
  if (startsWith(bytes, ascii('GIF8'))) return 'image/gif';
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'image/webp';
  return null;
}

export function checkReceiptFile(bytes: Uint8Array): FileCheck {
  if (bytes.length === 0) return { ok: false, message: 'That file is empty.' };
  if (bytes.length > MAX_RECEIPT_BYTES) {
    return { ok: false, message: 'That file is over 10 MB. Try a smaller photo or a PDF.' };
  }
  if (isHeic(bytes)) {
    return {
      ok: false,
      message: 'iPhone HEIC photos are not supported. Choose the photo again and pick JPEG, or take a screenshot of it.',
    };
  }
  const mediaType = sniff(bytes);
  if (mediaType === null) {
    return { ok: false, message: 'That does not look like a photo or a PDF. Use a JPEG, PNG, WebP, GIF or PDF.' };
  }
  return {
    ok: true,
    mediaType,
    extension: EXTENSION[mediaType],
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

/** A name safe to keep in a storage path: no directories, no spaces, no surprises, at most 80 characters. */
export function safeFilename(name: string, fallback: string): string {
  const last = name.split(/[\\/]/).pop() ?? '';
  const cleaned = last.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 80);
  return cleaned === '' || /^_+$/.test(cleaned) ? fallback : cleaned;
}
