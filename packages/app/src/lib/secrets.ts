// Provider API keys live in the OS credential store (Rust `secrets.rs`). The UI only ever sees
// "is it set" plus the last 4 characters. The one exception is `readCustomAiKey`: the wizard's
// "Custom AI service" writer calls its service from this webview and needs that one key. The provider keys
// are never handed back.
import { invoke } from '@tauri-apps/api/core';
import { t } from '../i18n';

/** The three provider keys, which also have a fallback field in the settings file. */
export type ProviderSecretName = 'anthropic_api_key' | 'openai_api_key' | 'openrouter_api_key';
/** The key of the person's own AI service (Settings and the agent wizard); kept in the credential store only. */
export const CUSTOM_AI_SECRET = 'custom_ai_key';
export type SecretName = ProviderSecretName | typeof CUSTOM_AI_SECRET;

export interface SecretMask {
  set: boolean;
  last4: string | null;
}

export interface SecretStorageInfo {
  secure: boolean;
  label: string;
}

export interface SecretsApi {
  storageInfo(): Promise<SecretStorageInfo>;
  getMasked(name: SecretName): Promise<SecretMask>;
  set(name: SecretName, value: string): Promise<void>;
  remove(name: SecretName): Promise<void>;
}

export const secretsApi: SecretsApi = {
  storageInfo: () => invoke<SecretStorageInfo>('secret_storage_info'),
  getMasked: (name) => invoke<SecretMask>('secret_get_masked', { name }),
  set: (name, value) => invoke<void>('secret_set', { name, value }),
  remove: (name) => invoke<void>('secret_delete', { name }),
};

/** The custom AI service key, or '' when none is set or no credential store is there. */
export async function readCustomAiKey(): Promise<string> {
  try {
    return (await invoke<string | null>('secret_get_custom_ai_key')) ?? '';
  } catch {
    return '';
  }
}

/** Mask a key held in the plain settings file (fallback when no credential store exists). */
export function maskLocal(value: string | undefined): SecretMask {
  const v = value ?? '';
  if (!v) return { set: false, last4: null };
  return { set: true, last4: v.length >= 12 ? v.slice(-4) : null };
}

/** Plain, true-in-every-state line describing a key. */
export function describeKeyState(mask: SecretMask, info: SecretStorageInfo): string {
  if (!mask.set) {
    return info.secure ? t('keys.state.notSetStored', { label: info.label }) : t('keys.state.notSet');
  }
  const dots = mask.last4 ? `•••• ${mask.last4}` : '••••';
  return info.secure
    ? `${dots} · ${t('keys.state.stored', { label: info.label })}`
    : `${dots} · ${t('keys.state.plain')}`;
}

export const NO_SECURE_STORAGE_WARNING =
  'Secure storage is not available on this computer. Keys you enter are saved in a plain file in the app folder.';

const SECRET_KEY_PATTERN = /(api_?key|token|secret|password)/i;

/** Settings safe to export: any secret-looking field is replaced, never copied. */
export function redactSettings<T extends object>(settings: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(settings)) {
    if (SECRET_KEY_PATTERN.test(k)) {
      if (typeof v === 'string' && v.length > 0) out[k] = '***';
      continue;
    }
    out[k] = v;
  }
  return out;
}
