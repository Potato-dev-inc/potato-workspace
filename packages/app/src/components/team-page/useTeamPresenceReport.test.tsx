// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PresenceReport, TeamApi } from '../../lib/team';
import { AWAY_AFTER_MS, CHANGE_SETTLE_MS, REPORT_EVERY_MS, useTeamPresenceReport, type PresenceFacts } from './useTeamPresenceReport';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const FACTS: PresenceFacts = { projectName: 'potato', projectPath: 'D:\\work\\potato', title: 'Fix the sheet', running: 2, waiting: 1 };

function Probe({ active, facts, api }: { active: boolean; facts: PresenceFacts; api: TeamApi }) {
  useTeamPresenceReport(active, facts, api);
  return null;
}
const fakeApi = () => {
  const reports: PresenceReport[] = [];
  return { reports, api: { presenceReport: async (r: PresenceReport) => void reports.push(r) } as unknown as TeamApi };
};

describe('useTeamPresenceReport', () => {
  it('sends the raw facts at once and every 30 seconds while Team is active (Rust applies what is shared)', async () => {
    const { reports, api } = fakeApi();
    await act(async () => root.render(<Probe active facts={FACTS} api={api} />));
    expect(reports).toHaveLength(1);
    expect(reports[0]).toEqual({ away: false, projectName: 'potato', projectPath: 'D:\\work\\potato', title: 'Fix the sheet', running: 2, waiting: 1 });
    await act(async () => void vi.advanceTimersByTime(REPORT_EVERY_MS));
    expect(reports.length).toBeGreaterThanOrEqual(2);
  });

  it('says away after five minutes without input, and back after input', async () => {
    const { reports, api } = fakeApi();
    await act(async () => root.render(<Probe active facts={FACTS} api={api} />));
    await act(async () => void vi.advanceTimersByTime(AWAY_AFTER_MS + REPORT_EVERY_MS));
    expect(reports.at(-1)!.away).toBe(true);
    await act(async () => void window.dispatchEvent(new Event('keydown')));
    await act(async () => void vi.advanceTimersByTime(REPORT_EVERY_MS));
    expect(reports.at(-1)!.away).toBe(false);
  });

  it('tells a change a second later, once for a run of quick changes (another chat)', async () => {
    const { reports, api } = fakeApi();
    await act(async () => root.render(<Probe active facts={FACTS} api={api} />));
    const before = reports.length;
    await act(async () => root.render(<Probe active facts={{ ...FACTS, title: 'Other chat' }} api={api} />));
    await act(async () => root.render(<Probe active facts={{ ...FACTS, title: 'Third chat' }} api={api} />));
    await act(async () => root.render(<Probe active facts={{ ...FACTS, title: 'Other chat' }} api={api} />));
    expect(reports.length).toBe(before);
    await act(async () => void vi.advanceTimersByTime(CHANGE_SETTLE_MS + 1));
    expect(reports.length).toBe(before + 1);
    expect(reports.at(-1)!.title).toBe('Other chat');
  });

  it('sends nothing while Team is not active', async () => {
    const { reports, api } = fakeApi();
    await act(async () => root.render(<Probe active={false} facts={FACTS} api={api} />));
    await act(async () => void vi.advanceTimersByTime(REPORT_EVERY_MS * 3));
    expect(reports).toHaveLength(0);
  });
});
