// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { clearDeviceLocalState } from './deviceLocalState';

const set = (k: string, v: unknown) => window.localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
const get = (k: string) => window.localStorage.getItem(k);

beforeEach(() => window.localStorage.clear());

describe('clearDeviceLocalState', () => {
  it('forgets a removed PC everywhere it was kept, and nothing of any other PC or any other app', () => {
    set('pm.remoteChat.device:n1:p1', []);
    set('pm.remoteChat.device:n2:p1', []);
    set('pm.remoteChat.__index', ['device:n1:p1', 'device:n2:p1']);
    set('pm.composerDrafts', { 'device:n1:p1': { text: 'a', at: 1 }, 'device:n2:p1': { text: 'b', at: 1 }, local: { text: 'c', at: 1 } });
    set('pm.plan.device:n1:p1', { step: 2 });
    set('pm.view.dev:n1:p1', 'chat');
    set('pm.cards.byPane', { 'dev:n1:p3': ['x'], 'dev:n2:p3': ['y'] });
    set('pm.devices.foldedProjects', ['n1:/repo', 'n2:/repo']);
    set('other.device:n1:p1', 'keep');
    clearDeviceLocalState('n1');
    expect(get('pm.remoteChat.device:n1:p1')).toBeNull();
    expect(get('pm.remoteChat.device:n2:p1')).not.toBeNull();
    expect(JSON.parse(get('pm.remoteChat.__index')!)).toEqual(['device:n2:p1']);
    expect(Object.keys(JSON.parse(get('pm.composerDrafts')!))).toEqual(['device:n2:p1', 'local']);
    expect(get('pm.plan.device:n1:p1')).toBeNull();
    expect(get('pm.view.dev:n1:p1')).toBeNull();
    expect(Object.keys(JSON.parse(get('pm.cards.byPane')!))).toEqual(['dev:n2:p3']);
    expect(get('other.device:n1:p1')).toBe('keep');
  });
});
