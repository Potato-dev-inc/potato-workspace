import { describe, expect, it } from 'vitest';
import { SettingsSchema } from './schemas';

describe('SettingsSchema ui_mode', () => {
  it('defaults to orchestration', () => {
    expect(SettingsSchema.parse({}).ui_mode).toBe('orchestration');
  });
  it('accepts individual and rejects unknown modes', () => {
    expect(SettingsSchema.parse({ ui_mode: 'individual' }).ui_mode).toBe('individual');
    expect(SettingsSchema.safeParse({ ui_mode: 'grid' }).success).toBe(false);
  });
});

describe('SettingsSchema after the built-in orchestrator was removed', () => {
  it('still loads a settings file that has the removed keys, and drops them', () => {
    const old = {
      default_provider: 'openrouter',
      default_model: 'x/y',
      custom_models: [{ provider: 'openrouter', model_id: 'x/y', label: 'X' }],
      orchestrator_backend: 'claude_cli',
      orchestrator_pane_id: 'p1',
      away_minutes: 9,
    };
    const parsed = SettingsSchema.parse(old) as Record<string, unknown>;
    expect(parsed.away_minutes).toBe(9);
    for (const gone of ['default_provider', 'default_model', 'custom_models', 'orchestrator_backend', 'orchestrator_pane_id']) {
      expect(parsed[gone], gone).toBeUndefined();
    }
  });

  it('keeps the custom AI service address and model, and has no field for its key', () => {
    const parsed = SettingsSchema.parse({ custom_ai: { preset: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'm' }, custom_ai_key: 'sk-secret' }) as Record<string, unknown>;
    expect(parsed.custom_ai).toEqual({ preset: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'm' });
    expect(parsed.custom_ai_key).toBeUndefined();
  });
});
