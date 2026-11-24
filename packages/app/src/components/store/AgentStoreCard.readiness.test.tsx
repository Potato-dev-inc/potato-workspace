// @vitest-environment jsdom
// A store card of an agent that is on the list says how it stands (the one readiness truth), not "Added and ready".
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { useEnglish } from '../../i18n/test-utils';
import type { StoreCard } from '../../lib/agent-store';
import { AgentStoreCard } from './AgentStoreCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
useEnglish();

const card = { id: 'codex', label: 'Codex', tagline: 'x', tier: 'verified', vendor: { name: 'V', license_kind: 'open_source' }, modes: [], state: 'ready', state_reason: 'Added and ready. The program is on this PC.', primary: null } as unknown as StoreCard;

describe('AgentStoreCard', () => {
  it('shows the readiness words for an added agent instead of the store sentence', async () => {
    const el = document.createElement('div');
    await act(async () => createRoot(el).render(<AgentStoreCard card={card} onOpen={() => undefined} standing={{ state: 'signed_in', label: 'Signed in', detail: null }} />));
    expect(el.querySelector('.ck-store-reason')?.textContent).toBe('Signed in');
    expect(el.textContent).not.toContain('Added and ready');
  });
});
