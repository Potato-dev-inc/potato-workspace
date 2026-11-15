// @vitest-environment jsdom
// A window with two Join-link hosts (the cockpit's and the Team page's, as when Settings is open inside the cockpit) shows ONE
// popup for a delivered link. When the first host goes away, the other one answers.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TeamApi } from '../../../lib/team';
import { JoinLinkHost } from './JoinTeamPopup';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LINK = 'https://pm-relay.maya.workers.dev/join/ABCDEFGH23456789';
const api = { inviteLookup: async () => ({ host: 'pm-relay.maya.workers.dev', teamName: 'Acme', inviter: 'Maya', expiresAtMs: Date.now() + 1000 }), inviteAccept: async () => ({}) } as unknown as Pick<TeamApi, 'inviteLookup' | 'inviteAccept'>;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const popups = () => host.querySelectorAll('[data-testid="join-popup"]').length;
const send = () => act(async () => void window.dispatchEvent(new CustomEvent('pm:join-link', { detail: LINK })));

describe('Join link hosts', () => {
  it('two hosts in one window show one popup', async () => {
    await act(async () =>
      root.render(
        <>
          <JoinLinkHost api={api} guess="Pat" />
          <JoinLinkHost api={api} guess="Pat" />
        </>,
      ),
    );
    await send();
    expect(popups()).toBe(1);
  });

  it('when the first host is gone, the second one answers', async () => {
    await act(async () =>
      root.render(
        <>
          <JoinLinkHost key="a" api={api} guess="Pat" />
          <JoinLinkHost key="b" api={api} guess="Pat" />
        </>,
      ),
    );
    await act(async () => root.render(<JoinLinkHost key="b" api={api} guess="Pat" />));
    await send();
    expect(popups()).toBe(1);
  });
});
