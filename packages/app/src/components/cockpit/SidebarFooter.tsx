// The bottom of the sidebar: one row of icon buttons with tooltips (Set up agents, Project, Review, Spaces), a More menu
// that holds the rest (Plans, Scores, the Orchestration | Individual mode), and Theme and Settings on the right.
// Background jobs and the Night Shift chip sit above the row (plan usage is the bottom bar, UsageBar.tsx) (they show only while there is something to say), and the
// "Connection lost" line sits under it.
import { useEffect, useRef, useState } from 'react';
import { IconChart, IconCheck, IconGlobe, IconMoon, IconMore, IconNote, IconSun, IconTerminal } from './Icons';
import { JobsChip } from './rail/JobsChip';
import { NightChip } from './night/NightChip';
import '../../styles/individual-mode.css';
import '../../styles/sidebar-footer.css';

type Mode = 'orchestration' | 'individual';

/** A gear, so Settings does not look like the Sun of the theme button. */
function GearIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="8" r="2.1" />
      <path d="M7 1.6h2l.4 1.7 1.3.6 1.5-.9 1.4 1.4-.9 1.5.6 1.3 1.7.4v2l-1.7.4-.6 1.3.9 1.5-1.4 1.4-1.5-.9-1.3.6L9 14.4H7l-.4-1.7-1.3-.6-1.5.9-1.4-1.4.9-1.5-.6-1.3-1.7-.4V7l1.7-.4.6-1.3-.9-1.5 1.4-1.4 1.5.9 1.3-.6z" />
    </svg>
  );
}

/** Visible from 900px wide up (sidebar-footer.css); below that only the icon and its tooltip show. */
const Label = ({ children }: { children: string }) => (
  <span className="ck-foot-label" aria-hidden="true">
    {children}
  </span>
);

export interface SidebarFooterProps {
  names: ReadonlyMap<string, string>;
  onOpenPane: (id: string) => void;
  mode: Mode;
  onMode: (mode: Mode) => void;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  onOpenSettings: (tab?: string) => void;
  bridgeLine?: string | null;
  onOpenDoctor?: () => void;
  onOpenMemory?: () => void;
  onOpenPlans?: () => void;
  onOpenScores?: () => void;
  onOpenReview?: () => void;
  reviewCount: number;
  onOpenMorning?: () => void;
  /** The Spaces button shows only when this is true and a handler is given. */
  spacesEnabled?: boolean;
  spacesOpen?: boolean;
  onOpenSpaces?: () => void;
}

export function SidebarFooter(p: SidebarFooterProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const moreBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!moreOpen) return;
    wrapRef.current?.querySelector<HTMLElement>('[role="menu"] [role^="menuitem"], [role="menu"] [role="radio"]')?.focus();
    const away = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setMoreOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMoreOpen(false);
        moreBtn.current?.focus();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const items = [...(wrapRef.current?.querySelectorAll<HTMLElement>('[role="menu"] [role^="menuitem"], [role="menu"] [role="radio"]') ?? [])];
        if (items.length === 0) return;
        e.preventDefault();
        const at = items.indexOf(document.activeElement as HTMLElement);
        items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      }
    };
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', key);
    };
  }, [moreOpen]);

  const pick = (run: () => void) => () => {
    setMoreOpen(false);
    run();
  };
  const reviewLabel = p.reviewCount > 0 ? `Review, ${p.reviewCount} waiting` : 'Review';

  return (
    <div className="ck-side-foot">
      <JobsChip names={p.names} onOpenPane={p.onOpenPane} />
      {p.onOpenMorning && <NightChip onOpenMorning={p.onOpenMorning} />}
      <div className="ck-foot-icons">
        {p.onOpenDoctor && (
          <button type="button" className="ck-icon-btn" aria-label="Set up agents" title="Set up agents" onClick={p.onOpenDoctor}>
            <IconTerminal />
            <Label>Set up agents</Label>
          </button>
        )}
        {p.onOpenMemory && (
          <button type="button" className="ck-icon-btn" aria-label="Project" title="Project" onClick={p.onOpenMemory}>
            <IconNote />
            <Label>Project</Label>
          </button>
        )}
        {p.onOpenReview && (
          <button type="button" className="ck-icon-btn ck-foot-review" aria-label={reviewLabel} title={reviewLabel} onClick={p.onOpenReview}>
            <IconCheck />
            <Label>{p.reviewCount > 0 ? `Review · ${p.reviewCount}` : 'Review'}</Label>
            {p.reviewCount > 0 && <span className="ck-side-count ck-foot-badge">{p.reviewCount}</span>}
          </button>
        )}
        {p.spacesEnabled && p.onOpenSpaces && (
          <button
            type="button"
            className={`ck-icon-btn${p.spacesOpen ? ' is-active' : ''}`}
            aria-label="Spaces"
            title="Spaces"
            aria-current={p.spacesOpen ? 'page' : undefined}
            onClick={p.onOpenSpaces}
          >
            <IconGlobe />
            <Label>Spaces</Label>
          </button>
        )}
        <div className="ck-menu-wrap" ref={wrapRef}>
          <button
            type="button"
            ref={moreBtn}
            className="ck-icon-btn"
            aria-label="More"
            title="More"
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((v) => !v)}
          >
            <IconMore />
            <Label>More</Label>
          </button>
          {moreOpen && (
            <div className="ck-menu ck-menu--up" role="menu" aria-label="More">
              {p.onOpenPlans && (
                <button type="button" role="menuitem" className="ck-menu-item" onClick={pick(p.onOpenPlans)}>
                  <span className="ck-menu-ic">
                    <IconChart />
                  </span>
                  Your plans
                </button>
              )}
              {p.onOpenScores && (
                <button type="button" role="menuitem" className="ck-menu-item" onClick={pick(p.onOpenScores)}>
                  <span className="ck-menu-ic">
                    <IconChart />
                  </span>
                  Scores
                </button>
              )}
              {(p.onOpenPlans || p.onOpenScores) && <div className="ck-menu-sep" role="separator" />}
              <div className="ck-menu-cap">Mode</div>
              <div className="ck-seg" role="radiogroup" aria-label="Mode" title="Each agent gets its own window; the main window hides.">
                {(['orchestration', 'individual'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={p.mode === m}
                    className={`ck-seg-opt${p.mode === m ? ' is-on' : ''}`}
                    title={m === 'individual' ? 'Each agent gets its own window; the main window hides.' : 'Every agent in this window.'}
                    onClick={pick(() => p.mode !== m && p.onMode(m))}
                  >
                    {m === 'orchestration' ? 'Orchestration' : 'Individual'}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <span className="ck-foot-spacer" />
        <button
          type="button"
          className="ck-icon-btn"
          onClick={p.onToggleTheme}
          title={p.theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
          aria-label="Toggle theme"
        >
          <span className={`ck-theme-ic${p.theme === 'light' ? ' is-light' : ''}`}>{p.theme === 'dark' ? <IconMoon /> : <IconSun />}</span>
          <Label>Theme</Label>
        </button>
        <button type="button" className="ck-icon-btn" aria-label="Settings" title="Settings" onClick={() => p.onOpenSettings()}>
          <GearIcon />
          <Label>Settings</Label>
        </button>
      </div>
      {p.bridgeLine && (
        <div className="ck-bridge" role="status">
          <span>Connection lost</span>
          <span aria-hidden="true"> · </span>
          <button type="button" className="ck-bridge-fix" onClick={() => p.onOpenSettings('bridge')}>
            Fix
          </button>
        </div>
      )}
    </div>
  );
}
