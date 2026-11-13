// The bottom of the sidebar: one row (Settings, Review with its count, and a ... menu). The menu holds everything else:
// Spaces, Project, Set up agents, Plans, Scores, Theme and the Orchestration | Individual mode.
// One status line sits above the row and only exists when there is something to say: the lost connection, else the
// background jobs, else a Night Shift run (plan usage is the bottom bar, UsageBar.tsx).
import { useRef, useState } from 'react';
import { FloatingMenu } from './FloatingMenu';
import { IconChart, IconCheck, IconGlobe, IconMoon, IconMore, IconNote, IconSun, IconTerminal } from './Icons';
import { JobsChip } from './rail/JobsChip';
import { NightChip } from './night/NightChip';
import '../../styles/individual-mode.css';
import '../../styles/sidebar-footer.css';
import { useT } from '../../i18n';

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
        <JobsChip names={p.names} onOpenPane={p.onOpenPane} />
        {p.onOpenMorning && <NightChip onOpenMorning={p.onOpenMorning} />}
      </div>
      <div className="ck-foot-icons">
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
              <button type="button" role="menuitem" className="ck-menu-item" onClick={pick(p.onToggleTheme)}>
                <span className="ck-menu-ic">{p.theme === 'dark' ? <IconSun /> : <IconMoon />}</span>
                {p.theme === 'dark' ? t('sidebar.switchToLight') : t('sidebar.switchToDark')}
              </button>
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
