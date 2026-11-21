// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { remoteProjectParts, remoteProjectPath, sshLocation } from './projectLocation';
import { readProjects, withLocatedProject, writeProjects } from './sidebarProjects';

describe('remote project keys', () => {
  it('host id plus folder is the key: the same folder on two machines never collides', () => {
    const a = remoteProjectPath('h1', '/srv/app');
    const b = remoteProjectPath('h2', '/srv/app');
    expect(a).not.toBe(b);
    let list = withLocatedProject([{ path: '/srv/app' }], a, sshLocation('h1', 'Box'));
    list = withLocatedProject(list, b, sshLocation('h2', 'Lab'));
    expect(list.map((p) => p.location?.kind ?? 'local')).toEqual(['local', 'ssh', 'ssh']);
    expect(list).toHaveLength(3);
    // Re-adding one keeps the other's badge.
    list = withLocatedProject(list, a, sshLocation('h1', 'Box renamed'));
    expect(list[2]!.location).toEqual(sshLocation('h2', 'Lab'));
  });

  it('the path names no folder of this PC, and parts come back out', () => {
    const p = remoteProjectPath('h1', '/srv/my app');
    expect(p.startsWith('\u0000')).toBe(true);
    expect(remoteProjectParts(p)).toEqual({ hostId: 'h1', folder: '/srv/my app' });
    expect(remoteProjectParts('/srv/my app')).toBeNull();
    // A folder of the home form keeps its `~`: the host id ends at the first character that is not part of an id.
    expect(remoteProjectParts(remoteProjectPath('7d1c0a52-aaaa', '~/x'))).toEqual({ hostId: '7d1c0a52-aaaa', folder: '~/x' });
    expect(remoteProjectParts('C:\work\app')).toBeNull();
  });

  it('saved projects from before (no location) stay local, and remote ones survive a reload of the list', () => {
    window.localStorage.setItem('pm.sidebar.projects', JSON.stringify([{ path: '/old/one' }]));
    expect(readProjects()).toEqual([{ path: '/old/one' }]);
    writeProjects([{ path: remoteProjectPath('h1', '/srv/app'), location: sshLocation('h1', 'Box') }, { path: '/old/one' }]);
    const back = readProjects();
    expect(back[0]!.location).toEqual(sshLocation('h1', 'Box'));
    expect(back[1]!.location).toBeUndefined();
    window.localStorage.clear();
  });
});
