import { describe, expect, it } from 'vitest';
import { sentFromLines } from './deviceNames';
import type { ChatTurn } from './sessionChatModel';
import { useEnglish } from '../i18n/test-utils';

const turn = (id: string, from: string | undefined): ChatTurn => ({ id, user: { text: 'x', from } } as unknown as ChatTurn);

describe('the quiet line under an app notice', () => {
  it('says a task was handed over for the hand-over notice, and keeps the old line for a finished agent', () => {
    useEnglish();
    const lines = sentFromLines([turn('a', 'app:handover'), turn('b', 'app:finished')], {});
    expect(lines.get('a')).toBe('from Potato Workspace: a task was handed over');
    expect(lines.get('b')).toBe('from Potato Workspace: an agent finished');
  });
});
