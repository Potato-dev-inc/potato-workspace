import { useEffect, useRef } from 'react';
import { teamApi, type PresenceReport, type TeamApi } from '../../lib/team';

/** How often the backend is told what I am doing (it also beats to the team about once a minute). */
export const REPORT_EVERY_MS = 30_000;
/** No pointer or key for this long: away. */
export const AWAY_AFTER_MS = 5 * 60_000;

export interface PresenceFacts {
  /** The selected chat's project folder name and path (null when no chat is open). */
  projectName: string | null;
  projectPath: string | null;
  /** The chat's title as the sidebar shows it. */
  title: string | null;
  running: number;
  waiting: number;
}

/**
 * Tells the Team backend what I am doing: every 30 seconds and when it changes. These are raw facts; the Rust side
 * applies "Share what I am doing" (default: only that I am here) and cleans the words before anything is sent.
 * Only while Team is active. Away: no pointer or key input for five minutes.
 */
export function useTeamPresenceReport(active: boolean, facts: PresenceFacts, api: TeamApi = teamApi): void {
  const lastInput = useRef(Date.now());
  const factsRef = useRef(facts);
  factsRef.current = facts;

  useEffect(() => {
    if (!active) return;
    const touch = () => {
      lastInput.current = Date.now();
    };
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel'] as const;
    for (const e of events) window.addEventListener(e, touch, { passive: true });
    return () => {
      for (const e of events) window.removeEventListener(e, touch);
    };
  }, [active]);

  const send = useRef(() => {});
  send.current = () => {
    if (!active || !api.presenceReport) return;
    const f = factsRef.current;
    const report: PresenceReport = { away: Date.now() - lastInput.current > AWAY_AFTER_MS, projectName: f.projectName, projectPath: f.projectPath, title: f.title, running: f.running, waiting: f.waiting };
    void Promise.resolve(api.presenceReport(report)).catch(() => {});
  };

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => send.current(), REPORT_EVERY_MS);
    return () => window.clearInterval(timer);
  }, [active]);

  // A change (another chat, a new title, an agent starts or waits) is told at once.
  useEffect(() => {
    send.current();
  }, [active, facts.projectPath, facts.projectName, facts.title, facts.running, facts.waiting]);
}
