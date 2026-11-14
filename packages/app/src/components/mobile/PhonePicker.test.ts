import { describe, expect, it } from 'vitest';
import { friendlyName } from './PhonePicker';

describe('friendlyName', () => {
  it('keeps the name the agent gave', () => {
    expect(friendlyName('DeepSeek V3', 'opencode-go/deepseek-v3')).toBe('DeepSeek V3');
  });
  it('cleans a raw id: drops the part before the slash, dashes to spaces', () => {
    expect(friendlyName('opencode-go/deepseek-v3', 'opencode-go/deepseek-v3')).toBe('deepseek v3');
    expect(friendlyName('', 'big_model')).toBe('big model');
  });
});
