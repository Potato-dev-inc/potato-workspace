import { describe, expect, it } from 'vitest';
import { findJoinLink, isPublicHost, parseJoinLink } from './join-link';

const CODE = 'ABCDEFGH23456789';

describe('parseJoinLink', () => {
  it('reads both shapes and normalises case', () => {
    const want = { code: CODE, host: 'pm-relay.me.workers.dev' };
    expect(parseJoinLink(`https://pm-relay.me.workers.dev/join/${CODE}`)).toEqual(want);
    expect(parseJoinLink(`  https://PM-relay.me.workers.dev/join/${CODE.toLowerCase()}/ `)).toEqual(want);
    expect(parseJoinLink(`potato-workspace://join/${CODE}?w=pm-relay.me.workers.dev`)).toEqual(want);
  });

  it('rejects junk, extra parts, private hosts and bad codes', () => {
    const junk = [
      '',
      'hello',
      'pm://team/join?v=1&t=x',
      'potato-workspace://join/',
      `potato-workspace://join/${CODE}`,
      `potato-workspace://join/${CODE}?w=`,
      `potato-workspace://join/${CODE}?w=a.dev&x=1`,
      `potato-workspace://join/${CODE}?w=a.dev&w=b.dev`,
      `potato-workspace://join/${CODE}?w=localhost`,
      `potato-workspace://join/${CODE}?w=127.0.0.1`,
      `potato-workspace://join/${CODE}?w=192.168.0.1`,
      `potato-workspace://join/${CODE}?w=a.dev:8080`,
      `potato-workspace://join/${CODE}?w=user@a.dev`,
      `potato-workspace://join/${CODE}?w=a.dev/evil`,
      `potato-workspace://join/${CODE}?w=-a.dev`,
      `potato-workspace://join/${CODE}?w=printer.local`,
      `potato-workspace://join/${CODE}?w=1.2.3.04`,
      'potato-workspace://join/ABCDEFGH2345678?w=a.dev',
      'potato-workspace://join/ABCDEFGH2345678O?w=a.dev',
      'potato-workspace://join/../../etc?w=a.dev',
      `http://a.dev/join/${CODE}`,
      `https://a.dev/other/${CODE}`,
      `https://a.dev/join/${CODE}/extra`,
      `https://user@a.dev/join/${CODE}`,
      `https://[::1]/join/${CODE}`,
      `https://a.dev/join/${CODE} && rm`,
      `https://a.dev/join/${CODE}\n`.replace(/\n$/, '\nx'),
      'javascript:alert(1)',
      `https://a.dev/join/${'A'.repeat(600)}`,
    ];
    for (const text of junk) expect(parseJoinLink(text), JSON.stringify(text)).toBeNull();
  });

  it('isPublicHost wants a DNS name', () => {
    expect(isPublicHost('pm-relay.me.workers.dev')).toBe(true);
    for (const bad of ['', 'localhost', 'a', 'a.local', 'x.internal', '10.0.0.1', '::1', 'a..dev', 'a_b.dev', 'a.dev.']) {
      expect(isPublicHost(bad), bad).toBe(false);
    }
  });

  it('finds a link inside a pasted message and ignores trailing punctuation', () => {
    const found = findJoinLink(`Join my team: https://pm.me.workers.dev/join/${CODE}. See you!`);
    expect(found?.text).toBe(`https://pm.me.workers.dev/join/${CODE}`);
    expect(found?.link.code).toBe(CODE);
    expect(findJoinLink('no link here')).toBeNull();
    expect(findJoinLink(`https://localhost/join/${CODE}`)).toBeNull();
  });
});
