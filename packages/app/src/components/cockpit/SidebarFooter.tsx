// The bottom of the sidebar: one row (Settings, Review with its count, and a ... menu). The menu holds everything else:
// Spaces, Project, Set up agents, Plans, Scores, Theme and the Orchestration | Individual mode.
// One status line sits above the row and only exists when there is something to say: the lost connection, else the
// background jobs, else a Night Shift run (plan usage is the bottom bar, UsageBar.tsx).
import { useRef, useState } from 'react';
import { FloatingMenu } from './FloatingMenu';
import { IconChart, IconCheck, IconClock, IconGlobe, IconMoon, IconMore, IconNote, IconSun, IconTerminal } from './Icons';
import { JobsChip } from './rail/JobsChip';
import type { HelperRow } from './rail/BackgroundSection';
import { NightChip } from './night/NightChip';
import { HelpMenu } from '../whatsnew/HelpMenu';
import '../../styles/individual-mode.css';
import '../../styles/sidebar-footer.css';
import { useT } from '../../i18n';
import { isDarkTheme, type ThemeChoice } from '../../lib/theme-tone';

const THEME_CHOICES = [
  ['dark', 'lookFeel.theme.dark'],
  ['light', 'lookFeel.theme.light'],
  ['dim', 'lookFeel.theme.dim'],
  ['auto', 'lookFeel.theme.auto'],
] as const;

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
  theme: ThemeChoice;
  onToggleTheme: () => void;
  /** Pick a theme by name: the "Theme" menu item. Without it the item is the old dark/light switch. */
  onSetTheme?: (next: ThemeChoice) => void;
  /** The helpers a pane started, shown in the background tasks list. */
  helpersOf?: (paneId: string) => readonly HelperRow[];
  onStopHelper?: (id: string) => Promise<void> | void;
  onOpenSettings: (tab?: string) => void;
  bridgeLine?: string | null;
  onOpenDoctor?: () => void;
  onOpenMemory?: () => void;
  onOpenPlans?: () => void;
  onOpenScores?: () => void;
  onOpenReview?: () => void;
  reviewCount: number;
  onOpenMorning?: () => void;
  onOpenRoutines?: () => void;
  /** The Spaces button shows only when this is true and a handler is given. */
  spacesEnabled?: boolean;
  spacesOpen?: boolean;
  onOpenSpaces?: () => void;
  /** The Today button shows only when this is given (Labs `timeline_day_enabled`). */
  onOpenToday?: () => void;
  todayOpen?: boolean;
}

export function SidebarFooter(p: SidebarFooterProps) {
  const t = useT();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreBtn = useRef<HTMLButtonElement>(null);

  const pick = (run: () => void) => () => {
    setMoreOpen(false);
    run();
  };
  const reviewLabel = p.reviewCount > 0 ? t('sidebar.reviewWaiting', { n: p.reviewCount }) : t('sidebar.review');

  return (
    <div className="ck-side-foot">
      <div className="ck-foot-status">
        {p.bridgeLine && (
          <div className="ck-bridge" role="status">
            <span>{t('sidebar.connectionLost')}</span>
            <span aria-hidden="true"> · </span>
            <button type="button" className="ck-bridge-fix" onClick={() => p.onOpenSettings('bridge')}>
              {t('sidebar.fix')}
            </button>
          </div>
        )}
        <JobsChip names={p.names} onOpenPane={p.onOpenPane} helpersOf={p.helpersOf} onStopHelper={p.onStopHelper} />
        {p.onOpenMorning && <NightChip onOpenMorning={p.onOpenMorning} />}
      </div>
      <div className="ck-foot-icons">
        <HelpMenu />
        <button type="button" className="ck-icon-btn" aria-label={t('sidebar.settings')} title={t('sidebar.settings')} onClick={() => p.onOpenSettings()}>
          <GearIcon />
          <Label>{t('sidebar.settings')}</Label>
        </button>
        {p.onOpenReview && (
          <button type="button" className="ck-icon-btn ck-foot-review" aria-label={reviewLabel} title={reviewLabel} onClick={p.onOpenReview}>
            <IconCheck />
            <Label>{p.reviewCount > 0 ? t('sidebar.reviewCount', { n: p.reviewCount }) : t('sidebar.review')}</Label>
            {p.reviewCount > 0 && <span className="ck-side-count ck-foot-badge">{p.reviewCount}</span>}
          </button>
        )}
        {p.onOpenToday && (
          <button type="button" className={`ck-icon-btn${p.todayOpen ? ' is-active' : ''}`} aria-label={t('sidebar.today')} title={t('sidebar.today')} aria-current={p.todayOpen ? 'page' : undefined} onClick={p.onOpenToday}>
            <IconClock />
            <Label>{t('sidebar.today')}</Label>
          </button>
        )}
        <span className="ck-foot-spacer" />
        <div className="ck-menu-wrap">
          <button
            type="button"
            ref={moreBtn}
            className="ck-icon-btn"
            aria-label={t('sidebar.more')}
            title={t('sidebar.more')}
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((v) => !v)}
          >
            <IconMore />
          </button>
          {moreOpen && (
            <FloatingMenu anchorRef={moreBtn} prefer="up" align="start" label={t('sidebar.more')} onClose={(back) => { setMoreOpen(false); if (back) moreBtn.current?.focus(); }}>
              {p.spacesEnabled && p.onOpenSpaces && (
                <button type="button" role="menuitem" className={`ck-menu-item${p.spacesOpen ? ' is-active' : ''}`} aria-current={p.spacesOpen ? 'page' : undefined} onClick={pick(p.onOpenSpaces)}>
                  <span className="ck-menu-ic">
                    <IconGlobe />
                  </span>
                  {t('sidebar.spaces')}
                </button>
              )}
              {p.onOpenMemory && (
                <button type="button" role="menuitem" className="ck-menu-item" onClick={pick(p.onOpenMemory)}>
                  <span className="ck-menu-ic">
                    <IconNote />
                  </span>
                  {t('sidebar.project')}
                </button>
              )}
              {p.onOpenDoctor && (
                <button type="button" role="menuitem" className="ck-menu-item" onClick={pick(p.onOpenDoctor)}>
                  <span className="ck-menu-ic">
                    <IconTerminal />
                  </span>
                  {t('sidebar.setUpAgents')}
                </button>
              )}
              {p.onOpenPlans && (
                <button type="button" role="menuitem" className="ck-menu-item" onClick={pick(p.onOpenPlans)}>
                  <span className="ck-menu-ic">
                    <IconChart />
                  </span>
                  {t('sidebar.yourPlans')}
                </button>
              )}
              {p.onOpenScores && (
                <button type="button" role="menuitem" className="ck-menu-item" onClick={pick(p.onOpenScores)}>
                  <span className="ck-menu-ic">
                    <IconChart />
                  </span>
                  {t('sidebar.scores')}
                </button>
              )}
              {p.onOpenRoutines && (
                <button type="button" role="menuitem" className="ck-menu-item" onClick={pick(p.onOpenRoutines)}>
                  <span className="ck-menu-ic">
                    <IconClock />
                  </span>
                  {t('sidebar.routines')}
                </button>
              )}
              {p.onSetTheme ? (
                <>
                  <div className="ck-menu-cap">{t('sidebar.theme')}</div>
                  {THEME_CHOICES.map(([value, key]) => (
                    <button
                      key={value}
                      type="button"
                      role="menuitemradio"
                      aria-checked={p.theme === value}
                      className={`ck-menu-item${p.theme === value ? ' is-active' : ''}`}
                      onClick={pick(() => p.theme !== value && p.onSetTheme?.(value))}
                    >
                      <span className="ck-menu-ic">{p.theme === value ? <IconCheck /> : value === 'dark' ? <IconMoon /> : <IconSun />}</span>
                      {t(key)}
                    </button>
                  ))}
                </>
              ) : (
                <button type="button" role="menuitem" className="ck-menu-item" onClick={pick(p.onToggleTheme)}>
                  <span className="ck-menu-ic">{isDarkTheme(p.theme) ? <IconSun /> : <IconMoon />}</span>
                  {isDarkTheme(p.theme) ? t('sidebar.switchToLight') : t('sidebar.switchToDark')}
                </button>
              )}
              <div className="ck-menu-sep" role="separator" />
              <div className="ck-menu-cap">{t('sidebar.mode')}</div>
              <div className="ck-seg" role="radiogroup" aria-label={t('sidebar.mode')} title={t('sidebar.modeTip')}>
                {(['orchestration', 'individual'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={p.mode === m}
                    className={`ck-seg-opt${p.mode === m ? ' is-on' : ''}`}
                    title={m === 'individual' ? t('sidebar.modeTip') : t('sidebar.modeEveryAgent')}
                    onClick={pick(() => p.mode !== m && p.onMode(m))}
                  >
                    {m === 'orchestration' ? t('sidebar.modeOrchestration') : t('sidebar.modeIndividual')}
                  </button>
                ))}
              </div>
            </FloatingMenu>
          )}
        </div>
      </div>
    </div>
  );
}
