import { describe, expect, it } from 'vitest';
import { DEV_LABS_KEYS } from './dev-labs';

describe('the SSH chat Labs switch', () => {
  it('joins the development Labs keys once', () => {
    expect(DEV_LABS_KEYS.filter((k) => k === 'ssh_chat_enabled')).toHaveLength(1);
  });
});
