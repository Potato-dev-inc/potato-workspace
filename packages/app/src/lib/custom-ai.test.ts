import { describe, expect, it, vi } from 'vitest';
import {
  askCustomAi,
  completionsUrl,
  CUSTOM_AI_PRESETS,
  normalizeBaseUrl,
  problemWithService,
  serviceForPreset,
} from './custom-ai';

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

describe('presets', () => {
  it('lists OpenRouter first with its base URL', () => {
    expect(CUSTOM_AI_PRESETS[0]).toMatchObject({ id: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' });
    expect(serviceForPreset('openrouter')).toMatchObject({ preset: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' });
    expect(serviceForPreset('other').baseUrl).toBe('');
  });
});

describe('addresses', () => {
  it('joins the base URL and /chat/completions without doubling slashes', () => {
    expect(completionsUrl('https://openrouter.ai/api/v1')).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(completionsUrl(' https://x.test/v1/// ')).toBe('https://x.test/v1/chat/completions');
    expect(normalizeBaseUrl(' https://x.test/ ')).toBe('https://x.test');
  });

  it('accepts https and a local http address, and says what is wrong otherwise', () => {
    const svc = (baseUrl: string, model = 'm') => ({ preset: 'other', baseUrl, model });
    expect(problemWithService(svc('https://api.example.com/v1'))).toBeNull();
    expect(problemWithService(svc('http://localhost:11434/v1'))).toBeNull();
    expect(problemWithService(svc(''))).toMatch(/address/);
    expect(problemWithService(svc('not a url'))).toMatch(/address/);
    expect(problemWithService(svc('http://example.com/v1'))).toMatch(/https/);
    expect(problemWithService(svc('https://api.example.com/v1', '  '))).toMatch(/model/);
  });
});

describe('askCustomAi', () => {
  it('posts to {baseUrl}/chat/completions with the key in Authorization and the chosen model', async () => {
    const fetchFn = vi.fn(async () => okResponse({ choices: [{ message: { content: ' hello ' } }] }));
    const text = await askCustomAi({
      service: { preset: 'other', baseUrl: 'https://llm.example.com/v1/', model: 'my-model' },
      apiKey: 'sk-test-123',
      prompt: 'the prompt',
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(text).toBe('hello');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://llm.example.com/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test-123');
    const body = JSON.parse(init.body as string) as { model: string; messages: Array<{ role: string; content: string }>; stream: boolean };
    expect(body.model).toBe('my-model');
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: 'the prompt' });
    expect(body.stream).toBe(false);
    expect(init.body as string).not.toContain('sk-test-123');
  });

  it('works for the OpenRouter preset and reads content given as parts', async () => {
    const fetchFn = vi.fn(async () => okResponse({ choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }] }));
    const text = await askCustomAi({ service: serviceForPreset('openrouter'), apiKey: 'k', prompt: 'p', fetchFn: fetchFn as unknown as typeof fetch });
    expect(text).toBe('a\nb');
    expect((fetchFn.mock.calls[0] as unknown as [string])[0]).toBe('https://openrouter.ai/api/v1/chat/completions');
  });

  it('refuses an empty answer, a missing key and an unsafe address before sending', async () => {
    const fetchFn = vi.fn(async () => okResponse({ choices: [{ message: { content: '' } }] }));
    const service = serviceForPreset('openrouter');
    await expect(askCustomAi({ service, apiKey: 'k', prompt: 'p', fetchFn: fetchFn as unknown as typeof fetch })).rejects.toThrow('empty');
    await expect(askCustomAi({ service, apiKey: '', prompt: 'p', fetchFn: fetchFn as unknown as typeof fetch })).rejects.toThrow('key');
    await expect(
      askCustomAi({ service: { preset: 'other', baseUrl: 'http://example.com', model: 'm' }, apiKey: 'k', prompt: 'p', fetchFn: fetchFn as unknown as typeof fetch }),
    ).rejects.toThrow('https');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('reports a failed call in plain words and never repeats the key', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 401, text: async () => 'bad key sk-secret-9' }) as unknown as Response);
    const err = await askCustomAi({ service: serviceForPreset('openai'), apiKey: 'sk-secret-9', prompt: 'p', fetchFn: fetchFn as unknown as typeof fetch }).catch((e: Error) => e);
    expect((err as Error).message).toContain('401');
    expect((err as Error).message).not.toContain('sk-secret-9');
  });
});
