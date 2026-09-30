import { describe, expect, it } from 'vitest';

import { MemoryReceiptStorage, ReceiptStorageError, createReceiptStorage, receiptStoragePath } from './storage';

describe('receiptStoragePath', () => {
  it('is the hash and a safe name, so the same bytes always land in the same place', () => {
    expect(receiptStoragePath('abc123', 'My Receipt.PDF', 'pdf')).toBe('abc123/My_Receipt.PDF');
  });

  it('falls back to a generic name when the file had none worth keeping', () => {
    expect(receiptStoragePath('abc123', '///', 'jpg')).toBe('abc123/receipt.jpg');
  });
});

describe('MemoryReceiptStorage', () => {
  it('keeps what it is given and hands out a URL for it', async () => {
    const storage = new MemoryReceiptStorage(new Map());

    await storage.put('h/r.pdf', new Uint8Array([1, 2]), 'application/pdf');

    await expect(storage.signedUrl('h/r.pdf', 60)).resolves.toContain('h%2Fr.pdf');
  });

  it('refuses a URL for something it never stored', async () => {
    const storage = new MemoryReceiptStorage(new Map());

    await expect(storage.signedUrl('nope', 60)).rejects.toBeInstanceOf(ReceiptStorageError);
  });
});

describe('createReceiptStorage', () => {
  it('is null with no storage credentials, so the caller must decide what that means', () => {
    expect(createReceiptStorage({ NODE_ENV: 'production' })).toBeNull();
  });

  it('is the in-memory store only when fixtures are enabled', () => {
    expect(createReceiptStorage({ RECEIPT_FIXTURES: '1', NODE_ENV: 'development' })).toBeInstanceOf(MemoryReceiptStorage);
    expect(createReceiptStorage({ RECEIPT_FIXTURES: '1', NODE_ENV: 'production' })).toBeNull();
  });

  it('is a real store when the service credentials are present', () => {
    const storage = createReceiptStorage({
      NODE_ENV: 'production',
      NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-key',
    });

    expect(storage).not.toBeNull();
    expect(storage).not.toBeInstanceOf(MemoryReceiptStorage);
  });
});
