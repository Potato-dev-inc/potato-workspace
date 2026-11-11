// @vitest-environment node
// The welcome speaks plain English: short sentences, short cards, none of the words the UX word list bans.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MAX_SENTENCES_PER_CARD, MAX_WORDS_PER_SENTENCE, sentencesOf, wordsOf } from '../simple/language-rules';
import { demoPrompt, ownStrings, T, TASK_PROMPT } from './copy';

const here = path.dirname(fileURLToPath(import.meta.url));

/** UX-PHASE1 section 0.3, right column: the engine's words. */
const BANNED = ['worktree', 'isolated', 'account', 'profile', 'subscription', 'quota', 'envelope', 'handle', 'doctor', 'hooks', 'checkpoint', 'restore', 'commit', 'branch', 'sandbox', 'ship'];

describe('first-run copy', () => {
  const all = ownStrings();

  it('checks a real number of strings', () => {
    expect(all.length).toBeGreaterThan(60);
  });

  it('every sentence is 15 words or fewer, and every card 3 sentences or fewer', () => {
    const bad = all.flatMap((text) => {
      const out: string[] = [];
      const sentences = sentencesOf(text);
      if (sentences.length > MAX_SENTENCES_PER_CARD) out.push(`${sentences.length} sentences: ${text}`);
      for (const s of sentences) {
        const n = s.split(/\s+/).filter((t) => /[A-Za-z0-9]/.test(t)).length;
        if (n > MAX_WORDS_PER_SENTENCE) out.push(`${n} words: ${s}`);
      }
      return out;
    });
    expect(bad).toEqual([]);
  });

  it('none of the banned engine words appears', () => {
    const bad = all.flatMap((text) => wordsOf(text).filter((w) => BANNED.includes(w)).map((w) => `${w}: ${text}`));
    expect(bad).toEqual([]);
  });

  it('uses the words of the list: separate copy, Sign in, Undo, History', () => {
    expect(T.looks.ai.hint).toContain('separate copy');
    expect(T.agentSignIn).toBe('Sign in');
    expect(T.tipHistory).toBe('History');
    expect(T.connectUndo).toBe('Undo');
    expect(T.tipHistoryBody).toContain('Undo');
  });

  it('the three answers are the founder wording', () => {
    expect(T.looks.code.label).toBe('I write code');
    expect(T.looks.ai.label).toBe('I build with AI, not much code');
    expect(T.looks.none.label).toBe("I don't code");
  });

  it('the demo prompt names our run_agent tool, so the agent does not run the other CLI itself', () => {
    expect(demoPrompt('Codex')).toContain('potato-workspace run_agent tool');
    // It must not ask for the read_only flag: with hidden helpers off, that raises a card a new user cannot answer.
    expect(demoPrompt('Codex')).not.toMatch(/read-only|read_only/);
    expect(demoPrompt('Codex')).toContain('not to change any files');
  });

  it('the demo prompt asks a named helper for a review and its answer', () => {
    // A prompt for an agent, not UI copy: it says "commit", a word the screens avoid.
    expect(demoPrompt('Codex')).toBe('Use the potato-workspace run_agent tool to have Codex review the last commit in this project and list 3 risks. Tell Codex not to change any files. Show me its answer.');
  });

  it('shows the same suggested prompt Rust sends', () => {
    const rust = readFileSync(path.join(here, '../../../src-tauri/src/first_run/mod.rs'), 'utf8');
    expect(rust).toContain(`"${TASK_PROMPT}"`);
    expect(TASK_PROMPT).toContain('Change nothing');
  });
});
