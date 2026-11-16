import { describe, expect, it } from 'vitest';
import { namerFrom, prettyModel, tidyName } from './modelNames';

describe('plain model names', () => {
  it('tidies a raw id into a name people read', () => {
    expect(prettyModel('opencode-go/deepseek-v4.1-flash')).toBe('DeepSeek V4.1 Flash');
    expect(prettyModel('opus')).toBe('Opus');
    expect(prettyModel('fable')).toBe('Fable');
  });

  it("drops a provider prefix and a trailing build number from the agent's own name", () => {
    expect(tidyName('opencode-go/DeepSeek V4.1 Flash 1017')).toBe('DeepSeek V4.1 Flash');
    expect(tidyName('Opus 5.5')).toBe('Opus 5.5');
  });

  it("prefers the agent's own name for a model, and says nothing for no model", () => {
    const name = namerFrom({ claude: { terminal: true, defaultModel: null, models: ['opus'], live: [{ value: 'opus', name: 'Opus 5.5', description: null }] } });
    expect(name('claude', 'opus')).toBe('Opus 5.5');
    expect(name('claude', 'haiku')).toBe('Haiku');
    expect(name('claude', null)).toBe('');
  });
});
