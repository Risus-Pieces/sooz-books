import type { LanguageModelV4 } from '@ai-sdk/provider';
import { UnsupportedFunctionalityError } from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';

import { createAnthropicModel } from './ai-suggest';

type CallOptions = Parameters<LanguageModelV4['doGenerate']>[0];

function stub(): { fetchImpl: typeof globalThis.fetch; bodies: Array<Record<string, unknown>> } {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl: typeof globalThis.fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(
      JSON.stringify({
        id: 'msg_1',
        model: 'claude-test',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  return { fetchImpl, bodies };
}

function prompt(role: 'user' | 'assistant', content: unknown[]): CallOptions {
  return { prompt: [{ role, content }] } as unknown as CallOptions;
}

function model(fetchImpl: typeof globalThis.fetch): LanguageModelV4 {
  return createAnthropicModel({ apiKey: 'sk-test', modelId: 'claude-test', fetchImpl });
}

const text = { type: 'text', text: 'read this' };

describe('createAnthropicModel with files', () => {
  it('sends a PNG as a base64 image block', async () => {
    const { fetchImpl, bodies } = stub();

    await model(fetchImpl).doGenerate(
      prompt('user', [text, { type: 'file', mediaType: 'image/png', data: { type: 'data', data: new Uint8Array([1, 2, 3]) } }]),
    );

    const messages = bodies[0].messages as Array<{ role: string; content: unknown[] }>;
    expect(messages[0].content).toEqual([
      { type: 'text', text: 'read this' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } },
    ]);
  });

  it('sends a PDF as a document block', async () => {
    const { fetchImpl, bodies } = stub();

    await model(fetchImpl).doGenerate(
      prompt('user', [{ type: 'file', mediaType: 'application/pdf', data: { type: 'data', data: new Uint8Array([1, 2, 3]) } }]),
    );

    const messages = bodies[0].messages as Array<{ content: unknown[] }>;
    expect(messages[0].content).toEqual([
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'AQID' } },
    ]);
  });

  it('takes base64 text and bare bytes as well as the tagged shape', async () => {
    const { fetchImpl, bodies } = stub();

    await model(fetchImpl).doGenerate(
      prompt('user', [
        { type: 'file', mediaType: 'image/jpeg', data: { type: 'data', data: 'AQID' } },
        { type: 'file', mediaType: 'image/jpeg', data: new Uint8Array([1, 2, 3]) },
      ]),
    );

    const messages = bodies[0].messages as Array<{ content: Array<{ source: { data: string } }> }>;
    expect(messages[0].content.map((block) => block.source.data)).toEqual(['AQID', 'AQID']);
  });

  it('still sends text-only prompts exactly as before', async () => {
    const { fetchImpl, bodies } = stub();

    await model(fetchImpl).doGenerate(prompt('user', [text]));

    const messages = bodies[0].messages as Array<{ content: unknown[] }>;
    expect(messages[0].content).toEqual([{ type: 'text', text: 'read this' }]);
  });

  it.each([
    ['a URL', { type: 'file', mediaType: 'image/png', data: { type: 'url', url: new URL('https://example.com/a.png') } }],
    ['an unsupported image type', { type: 'file', mediaType: 'image/heic', data: { type: 'data', data: new Uint8Array([1]) } }],
    ['audio', { type: 'file', mediaType: 'audio/mpeg', data: { type: 'data', data: new Uint8Array([1]) } }],
  ])('refuses %s, without calling the API', async (_name, part) => {
    const { fetchImpl, bodies } = stub();

    await expect(model(fetchImpl).doGenerate(prompt('user', [part]))).rejects.toBeInstanceOf(
      UnsupportedFunctionalityError,
    );
    expect(bodies).toHaveLength(0);
  });

  it('refuses a file in an assistant turn', async () => {
    const { fetchImpl } = stub();

    await expect(
      model(fetchImpl).doGenerate(
        prompt('assistant', [{ type: 'file', mediaType: 'image/png', data: { type: 'data', data: new Uint8Array([1]) } }]),
      ),
    ).rejects.toBeInstanceOf(UnsupportedFunctionalityError);
  });
});
