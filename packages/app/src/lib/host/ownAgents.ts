// "Use my own agents" (P6.1): this PC's agents, lent to another PC of mine for a chat that runs THERE. The far agent runs on the far PC; its
// model calls go through this PC (the lend proxy) with my sign-in; the login never leaves this PC.
//
// The order of a pick: the far PC has the agent (`ensureInstalledOnFar`), this PC writes down its own promise (`lend_far_offer`, a command of
// this window only), the far PC asks this PC back by that promise (`own_borrow_ask`, a far row that only ever asks its caller), and the
// far start carries `account: lend:<grant>`. Nothing is minted because the far side asked: the promise is this PC's own click.
import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';
import { t } from '../../i18n';
import { rawText } from '../sayError';
import { lendApi, type LendApi } from '../lend';
import type { Host } from './host';
import { ensureInstalledOnFar } from './ensureInstalled';

/** The account id of the page's "My sign-in" choice. It is never sent anywhere: the start swaps it for `lend:<grant>`. */
export const LEND_MINE = 'lend-mine';

/** What this PC wrote down for one pick (`lend_far_offer`). A lend already running for that PC and agent comes back as `grantId`. */
export interface FarOffer {
  offerRef: string;
  profileId: string;
  profileName: string;
  secs: number;
  grantId: string | null;
}

/** This PC's own commands for the pick (never a far call). */
export interface OwnAgentsApi {
  offer(node: string, agentId: string): Promise<FarOffer>;
  /** A far chat started on the lend: the grant lists it. */
  notePane(grantId: string, paneKey: string): Promise<void>;
  /** A far chat on the lend is alive: roll the lend on. */
  renew(grantId: string): Promise<number>;
}

const isTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
const call = <T,>(cmd: string, args: Record<string, unknown>): Promise<T> => (isTauri() ? invoke<T>(cmd, args) : Promise.reject(new Error('Desktop shell required')));

export const tauriOwnAgentsApi: OwnAgentsApi = {
  offer: (node, agentId) => call('lend_far_offer', { node, agent_id: agentId }),
  notePane: (grantId, paneKey) => call('lend_far_note_pane', { grant_id: grantId, pane_id: paneKey }),
  renew: (grantId) => call('lend_far_renew', { grant_id: grantId }),
};

/** What `buildRemoteNewAgent` needs to start a lent chat. Built per picked PC (`lendMine`). */
export interface RemoteLend {
  /** The lend for this agent on that PC: its grant id (the start sends `lend:<id>`). Throws one plain sentence. */
  mint(agentId: string, agentName: string): Promise<string>;
  ensureInstalled(agentId: string): Promise<'ready' | 'cancelled'>;
  /** The far chat started: the grant lists it, so its chip and Connect can name it. */
  started(grantId: string, farPaneKey: string): void;
}

/** The sentence for an error the far PC or this PC gave while the lend was made. */
function lendSentence(error: unknown, name: string, agentName: string): string {
  const text = rawText(error);
  if (text.startsWith('LEND_NO_SIGNIN')) return t('myAgents.signInFirst', { agent: agentName });
  if (/does not let this PC borrow|may not borrow/i.test(text)) return t('myAgents.notAllowed', { name });
  return text || t('myAgents.noAnswer', { name });
}

export function lendMine(opts: { host: Host; node: string; deviceName: string; api?: OwnAgentsApi }): RemoteLend {
  const api = opts.api ?? tauriOwnAgentsApi;
  return {
    ensureInstalled: (agentId) => ensureInstalledOnFar(opts.host, agentId),
    mint: async (agentId, agentName) => {
      try {
        const offer = await api.offer(opts.node, agentId);
        if (offer.grantId) return offer.grantId;
        const made = await opts.host.invoke<{ grantId?: string }>('own_borrow_ask', { agentId, offerRef: offer.offerRef, profileId: offer.profileId, secs: offer.secs });
        if (!made?.grantId) throw new Error(t('myAgents.noAnswer', { name: opts.deviceName }));
        return made.grantId;
      } catch (error) {
        throw new Error(lendSentence(error, opts.deviceName, agentName));
      }
    },
    started: (grantId, farPaneKey) => {
      void api.notePane(grantId, farPaneKey).catch(() => undefined);
    },
  };
}

/** An agent of this PC that can be lent for a chat. */
export interface MyAgent {
  agentId: string;
  label: string;
  /** The lend has a chat way to run. Without it only a terminal runs on the lend. */
  chat: boolean;
}

/** This PC's agents that have a lend spec (`support` is verified or lab), a chat or a terminal: Labs "Lend through my PC" must be on. Null: nothing to offer. */
export function useMyOwnAgents(on: boolean, api: LendApi = lendApi): MyAgent[] | null {
  const [agents, setAgents] = useState<MyAgent[] | null>(null);
  useEffect(() => {
    if (!on) {
      setAgents(null);
      return undefined;
    }
    let live = true;
    api
      .state()
      .then((s) => {
        if (!live) return;
        const list = s?.enabled ? s.drivers.filter((d) => d.support !== 'no' && (d.account || d.api_key)).map((d) => ({ agentId: d.agent_id, label: d.label, chat: d.chat })) : [];
        setAgents(list.length > 0 ? list : null);
      })
      .catch(() => live && setAgents(null));
    return () => {
      live = false;
    };
  }, [on, api]);
  return agents;
}
