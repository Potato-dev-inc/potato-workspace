// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { forgetRemotePane, loadRemotePanes, markRemotePane, remotePaneHost } from './remotePanes';

describe('remote panes', () => {
  it('a pane that was noted is remote until forgotten; an unknown pane is local', () => {
    expect(remotePaneHost('a')).toBeNull();
    markRemotePane('a', 'h1', 'Build box');
    expect(remotePaneHost('a')).toEqual({ hostId: 'h1', name: 'Build box' });
    forgetRemotePane('a');
    expect(remotePaneHost('a')).toBeNull();
    expect(remotePaneHost(null)).toBeNull();
  });

  it('the backend list brings chats back after a window reload, and a failed ask changes nothing', async () => {
    await loadRemotePanes(async () => [{ paneId: 'b', hostId: 'h2', name: 'Lab' }]);
    expect(remotePaneHost('b')).toEqual({ hostId: 'h2', name: 'Lab' });
    await loadRemotePanes(async () => {
      throw new Error('no shell');
    });
    expect(remotePaneHost('b')).toEqual({ hostId: 'h2', name: 'Lab' });
    await loadRemotePanes(async () => 'junk' as never);
    expect(remotePaneHost('b')).not.toBeNull();
  });
});
