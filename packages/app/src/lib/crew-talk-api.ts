// The command behind "Change the crew by talking" (`commands/crews_talk.rs`). It only PROPOSES a change: nothing is saved or
// applied by it. The canvas applies a proposal when the person presses Apply.
import { invoke } from '@tauri-apps/api/core';
import type { Crew } from './crews-api';

export type TalkChange =
  | { kind: 'handoff_added'; from: string; to: string }
  | { kind: 'handoff_removed'; from: string; to: string }
  | { kind: 'rule_added'; role: string; text: string }
  | { kind: 'rule_removed'; role: string; text: string };

export interface TalkOutcome {
  /** proposal: a change to look at. nothing: no change needed. refused: not routing, or it would break the crew. */
  status: 'proposal' | 'nothing' | 'refused';
  /** The front desk's sentence (proposal, nothing) or the plain reason (refused). */
  message: string;
  code: string | null;
  crew: Crew | null;
  routing_text: string | null;
  changes: TalkChange[];
  /** The agent that played the front desk (null: the app picked one). */
  asked: string | null;
}

export interface CrewTalkApi {
  talk: (crew: Crew, routingText: string, request: string) => Promise<TalkOutcome>;
}

const isTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const crewTalkApi: CrewTalkApi = {
  talk: async (crew, routingText, request) => {
    if (!isTauri()) throw new Error('Desktop shell required: crews_talk');
    return invoke<TalkOutcome>('crews_talk', { crew, routingText, request });
  },
};
