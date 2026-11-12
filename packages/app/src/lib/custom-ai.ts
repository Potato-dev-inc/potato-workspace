// "Custom AI service": the person's own AI service, reached with the common OpenAI-style
// `/chat/completions` call. The agent wizard's writer uses it today; a general custom provider can reuse the
// type, the presets and the client. The address and model are normal settings (`custom_ai`); the key is kept
// only in the OS credential store (secret `custom_ai_key`) and is read back at call time, never saved elsewhere.
import { maskEmails } from './agentWizardPrompt';
import { CUSTOM_AI_SECRET, readCustomAiKey, secretsApi, type SecretMask } from './secrets';
import { loadSettings, patchSettings } from './settings';

export type CustomAiPresetId = 'openrouter' | 'openai' | 'other';

export interface CustomAiService {
  /** Which preset the address came from. `other` is an address the person typed. */
  preset: string;
  /** The service address up to and including its version, such as `https://openrouter.ai/api/v1`. */
  baseUrl: string;
  model: string;
}

export interface CustomAiPreset {
  id: CustomAiPresetId;
  label: string;
  baseUrl: string;
  /** A model to start from. */
  model: string;
  hint: string;
  /** Extra request headers the service asks for. */
  headers?: Record<string, string>;
}

export const CUSTOM_AI_PRESETS: readonly CustomAiPreset[] = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'google/gemini-2.5-flash',
    hint: 'One key for many models. Some are free to try.',
    headers: { 'HTTP-Referer': 'https://github.com/Potato-dev-inc/potato-workspace', 'X-Title': 'Potato Workspace' },
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini',
    hint: 'Your OpenAI account key.',
  },
  {
    id: 'other',
    label: 'Other service',
    baseUrl: '',
    model: '',
    hint: 'Any service that works like OpenAI. Type its address.',
  },
];

export function presetById(id: string): CustomAiPreset | undefined {
  return CUSTOM_AI_PRESETS.find((p) => p.id === id);
}

/** A fresh service for a preset (its address and a starting model). */
export function serviceForPreset(id: CustomAiPresetId): CustomAiService {
  const preset = presetById(id) ?? CUSTOM_AI_PRESETS[0];
  return { preset: preset.id, baseUrl: preset.baseUrl, model: preset.model };
}

/** The address without spaces or trailing slashes. */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export function completionsUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/chat/completions`;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** A plain sentence about what is missing or unsafe, or null when the service can be called. */
export function problemWithService(service: CustomAiService): string | null {
  const base = normalizeBaseUrl(service.baseUrl);
  if (!base) return 'Type the service address.';
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return 'That address does not look right. It should start with https://';
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))) {
    return 'The address must start with https:// so your key travels safely.';
  }
  if (!service.model.trim()) return 'Type the model name.';
  return null;
}

const SYSTEM = 'You write agent definition files for Potato Workspace. Follow the instructions in the user message exactly.';

export interface AskCustomAiOptions {
  service: CustomAiService;
  apiKey: string;
  prompt: string;
  system?: string;
  maxTokens?: number;
  signal?: AbortSignal;
  /** For tests. */
  fetchFn?: typeof fetch;
}

type ContentPart = { type?: string; text?: string };

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as ContentPart[])
      .map((p) => (typeof p?.text === 'string' ? p.text : ''))
      .join('\n');
  }
  return '';
}

/** One question to the service, answered as text. The key goes in the `Authorization` header only. */
export async function askCustomAi(opts: AskCustomAiOptions): Promise<string> {
  const problem = problemWithService(opts.service);
  if (problem) throw new Error(problem);
  if (!opts.apiKey) throw new Error('Add the key for your custom AI service first.');
  const preset = presetById(opts.service.preset);
  const doFetch = opts.fetchFn ?? fetch;
  const res = await doFetch(completionsUrl(opts.service.baseUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${opts.apiKey}`,
      ...(preset?.headers ?? {}),
    },
    body: JSON.stringify({
      model: opts.service.model.trim(),
      messages: [
        { role: 'system', content: opts.system ?? SYSTEM },
        { role: 'user', content: opts.prompt },
      ],
      max_tokens: opts.maxTokens ?? 8000,
      stream: false,
    }),
    signal: opts.signal,
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).split(opts.apiKey).join('***').slice(0, 300);
    throw new Error(`The AI service answered ${res.status}${body ? `: ${body}` : '.'}`);
  }
  const json = (await res.json().catch(() => null)) as { choices?: Array<{ message?: { content?: unknown } }> } | null;
  const text = textOf(json?.choices?.[0]?.message?.content).trim();
  if (!text) throw new Error('The AI service returned an empty answer.');
  return text;
}

// ---- keeping the choice -----------------------------------------------------------------------

function isService(value: unknown): value is CustomAiService {
  const v = value as Partial<CustomAiService> | null;
  return Boolean(v) && typeof v?.preset === 'string' && typeof v.baseUrl === 'string' && typeof v.model === 'string';
}

/** What the person saved, or OpenRouter's starting values. */
export async function loadCustomAi(): Promise<CustomAiService> {
  const saved = (await loadSettings()).custom_ai;
  return isService(saved) ? { preset: saved.preset, baseUrl: saved.baseUrl, model: saved.model } : serviceForPreset('openrouter');
}

export async function customAiKeyMask(): Promise<SecretMask> {
  try {
    return await secretsApi.getMasked(CUSTOM_AI_SECRET);
  } catch {
    return { set: false, last4: null };
  }
}

/** Saves the address and model as settings and, when `key` is given, the key in the credential store. */
export async function saveCustomAi(service: CustomAiService, key?: string): Promise<void> {
  const trimmed = key?.trim();
  if (trimmed) await secretsApi.set(CUSTOM_AI_SECRET, trimmed);
  await patchSettings({ custom_ai: { preset: service.preset, baseUrl: normalizeBaseUrl(service.baseUrl), model: service.model.trim() } });
}

export interface CustomAiSupport {
  /** The saved service and whether a key is saved. */
  load(): Promise<{ service: CustomAiService; keySet: boolean; last4: string | null }>;
  /** Saves the service (and a newly typed key). */
  save(service: CustomAiService, key?: string): Promise<void>;
  ask(prompt: string, signal?: AbortSignal): Promise<string>;
}

export const customAiSupport: CustomAiSupport = {
  load: async () => {
    const [service, mask] = await Promise.all([loadCustomAi(), customAiKeyMask()]);
    return { service, keySet: mask.set, last4: mask.last4 };
  },
  save: saveCustomAi,
  ask: async (prompt, signal) => {
    const service = await loadCustomAi();
    const apiKey = await readCustomAiKey();
    if (!apiKey) throw new Error('Add the key for your custom AI service first.');
    return askCustomAi({ service, apiKey, prompt: maskEmails(prompt), signal });
  },
};
