import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getAppUser: vi.fn() }));
vi.mock('@/lib/receipts/ingest', () => ({ ingestReceipt: vi.fn() }));
vi.mock('@/lib/receipts/storage', () => ({ createReceiptStorage: vi.fn() }));
vi.mock('@/lib/receipts/extractor', () => ({ resolveReceiptExtractor: vi.fn(() => ({ extract: vi.fn() })) }));

import { getAppUser } from '@/lib/auth/session';
import type { AppRole } from '@/lib/types';
import { MAX_RECEIPT_BYTES } from '@/lib/receipts/files';
import { ingestReceipt } from '@/lib/receipts/ingest';
import { createReceiptStorage } from '@/lib/receipts/storage';
import type { ProposalView } from '@/lib/receipts/types';

import { POST } from './route';

const userWith = (role: AppRole) => ({
  id: 'u1',
  email: 'a@sooz.test',
  fullName: 'A',
  role,
  active: true,
  createdAt: new Date(),
  lastSignInAt: null,
});

const STORAGE = { put: vi.fn(), signedUrl: vi.fn() };
const pdf = () => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], 'r.pdf', { type: 'application/pdf' });

function upload(file?: File): NextRequest {
  const form = new FormData();
  if (file !== undefined) form.append('file', file);
  return new NextRequest('http://localhost/receipts/upload', { method: 'POST', body: form });
}

beforeEach(() => {
  vi.mocked(getAppUser).mockResolvedValue(userWith('owner'));
  vi.mocked(createReceiptStorage).mockReturnValue(STORAGE);
  vi.mocked(ingestReceipt).mockReset();
});

describe('POST /receipts/upload', () => {
  it('asks a signed-out visitor to sign in', async () => {
    vi.mocked(getAppUser).mockResolvedValue(null);

    const response = await POST(upload(pdf()));

    expect(response.status).toBe(401);
    expect(ingestReceipt).not.toHaveBeenCalled();
  });

  it('refuses a role that cannot post to the ledger', async () => {
    vi.mocked(getAppUser).mockResolvedValue(userWith('viewer'));

    const response = await POST(upload(pdf()));

    expect(response.status).toBe(403);
    expect(ingestReceipt).not.toHaveBeenCalled();
  });

  it('says so when there is nowhere to keep the file', async () => {
    vi.mocked(createReceiptStorage).mockReturnValue(null);

    const response = await POST(upload(pdf()));

    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatch(/storage/i);
  });

  it('needs a file', async () => {
    const response = await POST(upload());

    expect(response.status).toBe(400);
  });

  it('refuses a file over 10 MB before reading it', async () => {
    const big = new File([new Uint8Array(MAX_RECEIPT_BYTES + 1)], 'big.pdf', { type: 'application/pdf' });

    const response = await POST(upload(big));

    expect(response.status).toBe(413);
    expect(ingestReceipt).not.toHaveBeenCalled();
  });

  it('answers 422 with the reason when the file is not a receipt', async () => {
    vi.mocked(ingestReceipt).mockResolvedValue({ ok: false, message: 'That file is empty.' });

    const response = await POST(upload(pdf()));

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: 'That file is empty.' });
  });

  it('hands the uploader, name and bytes to ingest and returns the proposal', async () => {
    const proposal = { id: 'p1' } as ProposalView;
    vi.mocked(ingestReceipt).mockResolvedValue({ ok: true, proposal, alreadyFiled: false });

    const response = await POST(upload(pdf()));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ proposal, alreadyFiled: false });
    const [input, deps] = vi.mocked(ingestReceipt).mock.calls[0];
    expect(input.userId).toBe('u1');
    expect(input.filename).toBe('r.pdf');
    expect(input.bytes).toHaveLength(5);
    expect(deps.storage).toBe(STORAGE);
  });

  it('never leaks the text of an unexpected failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(ingestReceipt).mockRejectedValue(new Error('password authentication failed for user "sooz_app"'));

    const response = await POST(upload(pdf()));

    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain('sooz_app');
  });
});
