import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/client', () => ({ db: {} }));
vi.mock('@/lib/auth/session', () => ({ getAppUser: vi.fn() }));
vi.mock('@/lib/receipts/file-access', () => ({ receiptFilePath: vi.fn() }));
vi.mock('@/lib/receipts/storage', () => ({ createReceiptStorage: vi.fn() }));

import { getAppUser } from '@/lib/auth/session';
import { receiptFilePath } from '@/lib/receipts/file-access';
import { createReceiptStorage } from '@/lib/receipts/storage';

import { GET } from './route';

const ID = '3f2b8c1e-7a4d-4e9b-9c3a-1d5e6f708a9b';
const request = () => new NextRequest(`http://localhost/receipts/file/${ID}`);
const params = (attachmentId: string) => ({ params: Promise.resolve({ attachmentId }) });
const signedUrl = vi.fn(async () => 'https://storage.example/signed?token=abc');

beforeEach(() => {
  vi.mocked(getAppUser).mockResolvedValue({
    id: 'u1',
    email: 'a@sooz.test',
    fullName: 'A',
    role: 'viewer',
    active: true,
    createdAt: new Date(),
    lastSignInAt: null,
  });
  vi.mocked(receiptFilePath).mockResolvedValue('hash/receipt.pdf');
  vi.mocked(createReceiptStorage).mockReturnValue({ put: vi.fn(), signedUrl });
  signedUrl.mockClear();
});

describe('GET /receipts/file/[attachmentId]', () => {
  it('asks a signed-out visitor to sign in', async () => {
    vi.mocked(getAppUser).mockResolvedValue(null);

    expect((await GET(request(), params(ID))).status).toBe(401);
  });

  it('is not found for something that is not an id, or not a receipt', async () => {
    expect((await GET(request(), params('not-a-uuid'))).status).toBe(404);

    vi.mocked(receiptFilePath).mockResolvedValue(null);
    expect((await GET(request(), params(ID))).status).toBe(404);
  });

  it('says so when there is no storage', async () => {
    vi.mocked(createReceiptStorage).mockReturnValue(null);

    expect((await GET(request(), params(ID))).status).toBe(503);
  });

  it('redirects to a short-lived signed URL, and is never cached', async () => {
    const response = await GET(request(), params(ID));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://storage.example/signed?token=abc');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(signedUrl).toHaveBeenCalledWith('hash/receipt.pdf', 60);
  });
});
