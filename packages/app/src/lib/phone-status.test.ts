import { describe, expect, it } from 'vitest';
import { t } from '../i18n';
import { useEnglish } from '../i18n/test-utils';
import { durationWords, phoneStatus } from './phone-status';

useEnglish();
const note = { actionKind: 'tool' as const, action: 'Edit a.ts', step: 3, startedAt: 1_000_000 };

describe('phoneStatus: one status line for the header and the drawer', () => {
  it('says Ready, not Idle, for a chat with nothing going on', () => {
    expect(phoneStatus(t, { state: 'idle', now: 0 })).toMatchObject({ kind: 'ready', text: 'Ready', dot: 'none' });
  });
  it('says Working with the time and the step', () => {
    expect(phoneStatus(t, { state: 'working', note, now: 1_012_000 }).text).toBe('Working · 12s · step 3');
    expect(phoneStatus(t, { state: 'working', note, now: 1_130_000, total: 6 }).text).toBe('Working · 2m 10s · step 3 of 6');
  });
  it('says Needs you or Asking you, with the orange dot', () => {
    expect(phoneStatus(t, { state: 'needs', now: 0 })).toMatchObject({ kind: 'needs', dot: 'needs' });
    expect(phoneStatus(t, { state: 'risk', now: 0, asking: true })).toMatchObject({ kind: 'asking', text: 'Asking you' });
  });
  it('says Done with the time, Stopped for a failed chat', () => {
    expect(phoneStatus(t, { state: 'idle', now: 0, doneMs: 48_000 }).text).toBe('Done · 48s');
    expect(phoneStatus(t, { state: 'broken', now: 0 })).toMatchObject({ kind: 'stopped', dot: 'danger' });
  });
  it('Sending and Offline win over the chat state', () => {
    expect(phoneStatus(t, { state: 'working', note, now: 0, sending: true }).text).toBe('Sending…');
    expect(phoneStatus(t, { state: 'working', note, now: 0, sending: true, offline: true }).text).toBe('Offline');
  });
  it('formats short times', () => {
    expect(durationWords(t, 3000)).toBe('3s');
    expect(durationWords(t, 180_000)).toBe('3m');
  });
});
