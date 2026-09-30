import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RECEIPT_MODEL_ID,
  ExtractionError,
  createClaudeExtractor,
  createFixtureExtractor,
  resolveReceiptExtractor,
} from './extractor';
import { devFixturesEnabled } from './fixtures';

const ACCOUNTS_GIVEN = [
  { code: '1320', name: 'Raw Ingredients', description: null },
  { code: '1330', name: 'Packaging Materials', description: null },
];

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]); // %PDF-1

/** A fetch that answers as the Messages API does when a tool call is forced. */
function stubFetch(answer: Record<string, unknown> | { status: number; body: string }): {
  fetchImpl: typeof globalThis.fetch;
  bodies: Array<Record<string, unknown>>;
} {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl: typeof globalThis.fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if ('status' in answer && 'body' in answer) {
      return new Response(String(answer.body), { status: Number(answer.status) });
    }
    return new Response(
      JSON.stringify({
        id: 'msg_1',
        model: 'claude-test',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'record_suggestions', input: answer }],
        usage: { input_tokens: 10, output_tokens: 10 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  return { fetchImpl, bodies };
}

const GOOD_ANSWER = {
  legible: true,
  vendorName: 'Pack Supply Co',
  date: '2026-09-15',
  subtotal: '38.00',
  tax: '3.10',
  tip: null,
  total: '41.10',
  cardLast4: '4242',
  items: [{ description: 'Shipper cartons', amount: '38.00', accountCode: '1330' }],
};

describe('createClaudeExtractor', () => {
  it('sends the file to the model and reads the answer into cents', async () => {
    const { fetchImpl, bodies } = stubFetch(GOOD_ANSWER);
    const extractor = createClaudeExtractor({ apiKey: 'sk-test', fetchImpl });

    const receipt = await extractor.extract({ bytes: PDF_BYTES, mediaType: 'application/pdf', accounts: ACCOUNTS_GIVEN });

    expect(receipt.totalCents).toBe(4110);
    expect(receipt.items).toEqual([{ description: 'Shipper cartons', cents: 3800, accountCode: '1330' }]);

    // The file really reached the API as a document, through the SDK and the adapter.
    const body = bodies[0] as { model: string; messages: Array<{ content: Array<{ type: string; text?: string }> }> };
    const blocks = body.messages[0].content;
    expect(blocks.map((b) => b.type)).toContain('document');
    // The accounts the model may choose from are in the prompt.
    expect(blocks.find((b) => b.type === 'text')?.text).toContain('1330');
    expect(body.model).toBe(DEFAULT_RECEIPT_MODEL_ID.replace(/^anthropic\//, ''));
  });

  it('sends no sampling parameters (claude-sonnet-5 rejects them with HTTP 400)', async () => {
    const { fetchImpl, bodies } = stubFetch(GOOD_ANSWER);
    const extractor = createClaudeExtractor({ apiKey: 'sk-test', fetchImpl });

    await extractor.extract({ bytes: PDF_BYTES, mediaType: 'application/pdf', accounts: ACCOUNTS_GIVEN });

    expect(bodies[0]).not.toHaveProperty('temperature');
    expect(bodies[0]).not.toHaveProperty('top_p');
    expect(bodies[0]).not.toHaveProperty('top_k');
  });

  it('says there is no model, in words, when no key is configured', async () => {
    const extractor = createClaudeExtractor({ apiKey: '', fetchImpl: stubFetch(GOOD_ANSWER).fetchImpl });

    await expect(
      extractor.extract({ bytes: PDF_BYTES, mediaType: 'application/pdf', accounts: ACCOUNTS_GIVEN }),
    ).rejects.toMatchObject({ name: 'ExtractionError', kind: 'no_model' });
  });

  it('reports an amount it cannot read as unreadable', async () => {
    const { fetchImpl } = stubFetch({ ...GOOD_ANSWER, total: 'forty-one' });
    const extractor = createClaudeExtractor({ apiKey: 'sk-test', fetchImpl });

    const error = await extractor
      .extract({ bytes: PDF_BYTES, mediaType: 'application/pdf', accounts: ACCOUNTS_GIVEN })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExtractionError);
    expect((error as ExtractionError).kind).toBe('unreadable');
    expect((error as ExtractionError).message).toMatch(/total/);
  });

  it('reports a rate limit and a server fault distinctly', async () => {
    const limited = createClaudeExtractor({
      apiKey: 'sk-test',
      fetchImpl: stubFetch({ status: 429, body: '{"error":{"message":"slow down"}}' }).fetchImpl,
    });
    const broken = createClaudeExtractor({
      apiKey: 'sk-test',
      fetchImpl: stubFetch({ status: 500, body: '{"error":{"message":"oops"}}' }).fetchImpl,
    });
    const input = { bytes: PDF_BYTES, mediaType: 'application/pdf' as const, accounts: ACCOUNTS_GIVEN };

    await expect(limited.extract(input)).rejects.toMatchObject({ kind: 'rate_limit' });
    await expect(broken.extract(input)).rejects.toMatchObject({ kind: 'failed' });
  });

  it('gives up on a model that never answers', async () => {
    const hang: typeof globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
      });
    const extractor = createClaudeExtractor({ apiKey: 'sk-test', fetchImpl: hang, timeoutMs: 20 });

    await expect(
      extractor.extract({ bytes: PDF_BYTES, mediaType: 'application/pdf', accounts: ACCOUNTS_GIVEN }),
    ).rejects.toMatchObject({ kind: 'timeout' });
  });
});

describe('fixtures', () => {
  it('are on only in development or test, and never on Vercel', () => {
    expect(devFixturesEnabled({ RECEIPT_FIXTURES: '1', NODE_ENV: 'development' })).toBe(true);
    expect(devFixturesEnabled({ RECEIPT_FIXTURES: '1', NODE_ENV: 'test' })).toBe(true);
    expect(devFixturesEnabled({ RECEIPT_FIXTURES: '1', NODE_ENV: 'production' })).toBe(false);
    expect(devFixturesEnabled({ RECEIPT_FIXTURES: '1' } as NodeJS.ProcessEnv)).toBe(false);
    expect(devFixturesEnabled({ RECEIPT_FIXTURES: '1', NODE_ENV: 'development', VERCEL: '1' })).toBe(false);
    expect(devFixturesEnabled({ NODE_ENV: 'development' })).toBe(false);
  });

  it('the fixture extractor returns one fixed, valid receipt', async () => {
    const receipt = await createFixtureExtractor().extract({
      bytes: PDF_BYTES,
      mediaType: 'application/pdf',
      accounts: ACCOUNTS_GIVEN,
    });

    expect(receipt.vendorName).toBe('E2E Packaging Supply');
    expect(receipt.totalCents).toBe(4210);
    expect(receipt.items[0].cents + receipt.taxCents).toBe(4210);
  });

  it('resolveReceiptExtractor uses the fixture only when fixtures are enabled', async () => {
    const input = { bytes: PDF_BYTES, mediaType: 'application/pdf' as const, accounts: ACCOUNTS_GIVEN };

    const fixture = await resolveReceiptExtractor({ RECEIPT_FIXTURES: '1', NODE_ENV: 'development' }).extract(input);
    expect(fixture.vendorName).toBe('E2E Packaging Supply');

    await expect(resolveReceiptExtractor({ NODE_ENV: 'production' }).extract(input)).rejects.toMatchObject({
      kind: 'no_model',
    });
  });
});
