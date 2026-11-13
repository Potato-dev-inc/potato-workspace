import { describe, expect, it, vi } from 'vitest';
import { t } from '../../i18n';
import { bellMenuActions } from './bell-menu';

describe('bellMenuActions', () => {
  it('makes one row per level, in order, and marks the level in use', () => {
    const rows = bellMenuActions('needs', () => {}, t);
    expect(rows.map((r) => r.id)).toEqual(['bell-everything', 'bell-needs', 'bell-finished', 'bell-silent']);
    expect(rows[1].label).toBe('Alerts: Only when it needs me (now)');
    expect(rows[0].label).toBe('Alerts: Everything');
  });

  it('choosing a row sets that level', () => {
    const set = vi.fn();
    const rows = bellMenuActions('everything', set, t);
    rows[2].onSelect();
    expect(set).toHaveBeenCalledWith('finished');
  });

  it('every row carries the plain tip', () => {
    for (const row of bellMenuActions('silent', () => {}, t)) {
      expect(row.title).toBe('How much this agent may interrupt you. A high-risk approval always comes through.');
    }
  });
});
