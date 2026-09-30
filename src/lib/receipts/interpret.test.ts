import { describe, expect, it } from 'vitest';

import { interpretMessage } from './interpret';

const SNAPSHOT = {
  vendorName: 'Pack Supply Co',
  date: '2026-09-15',
  totalCents: 4110,
  payerName: 'Risus Zhao',
  lines: [
    { description: 'Cartons', cents: 3000, accountLabel: 'Packaging Materials (1330)' },
    { description: 'Sugar', cents: 1110, accountLabel: null },
  ],
};

const REFS = {
  accounts: [
    { code: '1320', name: 'Raw Ingredients' },
    { code: '1330', name: 'Packaging Materials' },
  ],
  members: [{ name: 'Risus Zhao' }, { name: 'Mo Chen' }],
};

function stubFetch(answer: Record<string, unknown>): {
  fetchImpl: typeof globalThis.fetch;
  bodies: Array<Record<string, unknown>>;
} {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl: typeof globalThis.fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
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

describe('interpretMessage', () => {
  it('turns a message into edits, and shows the model the card, the accounts and the members', async () => {
    const { fetchImpl, bodies } = stubFetch({
      edits: [{ kind: 'set_account', line: 2, accountCode: '1320' }],
      unclear: null,
    });

    const result = await interpretMessage('the sugar is ingredients', SNAPSHOT, REFS, { apiKey: 'sk-test', fetchImpl });

    expect(result).toEqual({ edits: [{ kind: 'set_account', line: 2, accountCode: '1320' }], unclear: null });
    const body = bodies[0] as { messages: Array<{ content: Array<{ type: string; text?: string }> }> };
    const text = body.messages[0].content.find((b) => b.type === 'text')?.text ?? '';
    expect(text).toContain('the sugar is ingredients');
    expect(text).toContain('1. Cartons');
    expect(text).toContain('2. Sugar');
    expect(text).toContain('1320  Raw Ingredients');
    expect(text).toContain('Mo Chen');
  });

  it('passes on what the model says it could not understand', async () => {
    const { fetchImpl } = stubFetch({ edits: [], unclear: 'Which line do you mean?' });

    const result = await interpretMessage('fix it', SNAPSHOT, REFS, { apiKey: 'sk-test', fetchImpl });

    expect(result).toEqual({ edits: [], unclear: 'Which line do you mean?' });
  });

  it('says there is no model, in words, when none is configured', async () => {
    await expect(
      interpretMessage('anything', SNAPSHOT, REFS, { apiKey: '', fetchImpl: stubFetch({}).fetchImpl }),
    ).rejects.toMatchObject({ name: 'ExtractionError', kind: 'no_model' });
  });

  it('treats an edit the schema does not allow as an unreadable answer, not as a command', async () => {
    const { fetchImpl } = stubFetch({ edits: [{ kind: 'delete_everything' }], unclear: null });

    await expect(
      interpretMessage('post it to owner draws', SNAPSHOT, REFS, { apiKey: 'sk-test', fetchImpl }),
    ).rejects.toMatchObject({ kind: 'unreadable' });
  });

  it('refuses an empty message without calling the model', async () => {
    const { fetchImpl, bodies } = stubFetch({ edits: [], unclear: null });

    const result = await interpretMessage('   ', SNAPSHOT, REFS, { apiKey: 'sk-test', fetchImpl });

    expect(result).toEqual({ edits: [], unclear: 'Type what you want to change.' });
    expect(bodies).toHaveLength(0);
  });
});
