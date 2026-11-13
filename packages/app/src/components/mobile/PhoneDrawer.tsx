// The phone's list of chats, a drawer from the top-left: search, "Needs you", chats grouped by project, the PC's state and
// Settings at the foot. It replaces the tab strip and the Agents home. A swipe from the left edge or the menu button opens
// it; a swipe back, the scrim or Escape closes it. Each row has the agent's brand icon, a state dot and the state in words.
import { useEffect, useRef, useState, type ReactNode, type TouchEvent as ReactTouchEvent } from 'react';
import type { PaneInfo } from '@potato-workspace/shared';
import { useT, type MessageKey } from '../../i18n';
import type { AttentionSnapshot } from '../../lib/attention';
import { ALL_TAB, companionTab } from '../../lib/mobile-agent-tabs';
import type { CompanionView } from '../../lib/companion';
import { stateWord } from '../../lib/companion';
import { AgentLogo } from '../common/AgentLogo';
import { Avatar } from '../companion/Avatar';
import { groupByProject, needsPaneIds, rowState, type RowState } from './phoneNav';
import type { RuleLimit } from '../../lib/pane-rule-view';
import '../../styles/phone-shell.css';
import '../../styles/phone-link.css';

/** A press this long on a row opens its small menu (Stop, Close). */
export const LONG_PRESS_MS = 500;

const STATE_KEY: Record<RowState, MessageKey> = {
  needs: 'phone.state.needs',
  working: 'phone.state.working',
  risk: 'phone.state.risk',
  broken: 'phone.state.broken',
  idle: 'phone.state.idle',
};

/** A swipe must start this close to the left edge to open the drawer. */
export const EDGE_PX = 24;
/** ...and travel this far across. */
export const SWIPE_OPEN_PX = 56;

/** Opens the drawer on a swipe that starts at the left edge. Attach the returned handlers to the page's root. */
export function useEdgeSwipe(onOpen: () => void, enabled: boolean) {
  const start = useRef<{ x: number; y: number } | null>(null);
  return {
    onTouchStart: (event: ReactTouchEvent) => {
      const touch = event.touches[0];
      start.current = enabled && touch && touch.clientX <= EDGE_PX ? { x: touch.clientX, y: touch.clientY } : null;
    },
    onTouchMove: (event: ReactTouchEvent) => {
      const from = start.current;
      const touch = event.touches[0];
      if (!from || !touch) return;
      const dx = touch.clientX - from.x;
      const dy = Math.abs(touch.clientY - from.y);
      if (dx >= SWIPE_OPEN_PX && dx > dy * 1.5) {
        start.current = null;
        onOpen();
      }
    },
    onTouchEnd: () => {
      start.current = null;
    },
  };
}

function ageWords(t: ReturnType<typeof useT>, at: number | null, now: number): string | null {
  if (at === null) return null;
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return t('phone.ago.now');
  if (seconds < 3600) return t('phone.ago.min', { n: Math.floor(seconds / 60) });
  return t('phone.ago.hour', { n: Math.floor(seconds / 3600) });
}

function Row({
  pane,
  title,
  state,
  active,
  agentName,
  onOpen,
  onMenu,
  lock,
  now,
}: {
  pane: PaneInfo;
  title: string;
  state: RowState;
  active: boolean;
  agentName: string;
  onOpen: () => void;
  /** Long press or the context key: open this row menu. Absent: no menu. */
  onMenu?: () => void;
  /** The PC keeps this phone from going all the way in this agent: a lock on the row. */
  lock: RuleLimit | null;
  now: number;
}) {
  const t = useT();
  const age = ageWords(t, pane.last_output_at, now);
  const press = useRef(0);
  const held = useRef(false);
  const endPress = () => window.clearTimeout(press.current);
  return (
    <li>
      <button
        type="button"
        className="ph-drow"
        data-state={state}
        aria-current={active ? 'true' : undefined}
        aria-haspopup={onMenu ? 'menu' : undefined}
        onPointerDown={(event) => {
          if (!onMenu || (event.pointerType === 'mouse' && event.button !== 0)) return;
          held.current = false;
          endPress();
          press.current = window.setTimeout(() => {
            held.current = true;
            onMenu();
          }, LONG_PRESS_MS);
        }}
        onPointerUp={endPress}
        onPointerLeave={endPress}
        onPointerCancel={endPress}
        onContextMenu={(event) => {
          if (!onMenu) return;
          event.preventDefault();
          held.current = true;
          onMenu();
        }}
        onClick={() => {
          if (held.current) {
            held.current = false;
            return;
          }
          onOpen();
        }}
      >
        <span className="ph-drow-icon">
          <AgentLogo id={pane.agent_type} name={agentName} size={22} decorative />
          <span className="ph-dot" data-state={state} aria-hidden="true" />
        </span>
        <span className="ph-drow-text">
          <span className="ph-drow-title">{title}</span>
          <span className="ph-drow-state">
            {t(STATE_KEY[state])}
            {age ? ` · ${age}` : ''}
          </span>
        </span>
        {lock && (
          <svg className="ph-lock" viewBox="0 0 24 24" role="img" aria-label={t(lock === 'off' ? 'phone.lock.off' : lock === 'watch' ? 'phone.lock.watch' : 'phone.lock.answer')} data-lock={lock}>
            <rect x="5" y="11" width="14" height="9" rx="2" />
            <path d="M8 11V8a4 4 0 0 1 8 0v3" />
          </svg>
        )}
      </button>
    </li>
  );
}

export function PhoneDrawer({
  open,
  onClose,
  panes,
  labels,
  agentName,
  attention,
  active,
  bridgeReady,
  companions = [],
  onSelect,
  onSearch,
  onOverview,
  onSettings,
  children,
  locks,
  onStopPane,
  onClosePane,
}: {
  open: boolean;
  onClose: () => void;
  /** Agent panes in tab order (no companion panes). */
  panes: PaneInfo[];
  labels: Map<string, string>;
  /** The agent's display name from the registry, for the icon's label. */
  agentName: (agentType: string) => string;
  attention: AttentionSnapshot | null;
  /** The open tab (a pane id, a companion tab or the overview). */
  active: string;
  bridgeReady: boolean;
  companions?: CompanionView[];
  /** A row was tapped: a pane id or a companion tab. */
  onSelect: (tab: string) => void;
  onSearch: () => void;
  onOverview: () => void;
  onSettings: () => void;
  /** Night, Review and Focus summaries: cards at the top of the drawer. */
  children?: ReactNode;
  /** Per agent: how far the PC lets this phone go (a lock on its row). Agents with no entry have no limit. */
  locks?: Record<string, RuleLimit | null>;
  /** Stop one agent turn. Without it the row menu has no Stop. */
  onStopPane?: (paneId: string) => Promise<string | null>;
  /** Close one agent (asked about first). Without it the row menu has no Close. */
  onClosePane?: (paneId: string) => void;
}) {
  const t = useT();
  const [menu, setMenu] = useState<{ paneId: string; title: string } | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [menuError, setMenuError] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const [now, setNow] = useState(() => Date.now());
  const drag = useRef<{ x: number; y: number } | null>(null);
  const menuRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Escape closes the row menu first, the drawer second.
      if (menuRef.current) {
        menuRef.current = false;
        setMenu(null);
        setConfirmClose(false);
      } else onClose();
    };
    window.addEventListener('keydown', onKey);
    // Keyboard and screen reader users land inside the drawer.
    panelRef.current?.querySelector<HTMLElement>('button')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  menuRef.current = menu !== null;
  if (!open) return null;

  const needs = needsPaneIds(panes, attention);
  const waiting = panes.filter((pane) => needs.has(pane.id));
  const groups = groupByProject(panes, needs);
  const rowFor = (pane: PaneInfo) => (
    <Row
      key={pane.id}
      pane={pane}
      title={labels.get(pane.id) ?? pane.agent_type}
      state={rowState(pane, needs, attention)}
      active={active === pane.id}
      agentName={agentName(pane.agent_type)}
      now={now}
      lock={locks?.[pane.id] ?? null}
      onMenu={
        onStopPane || onClosePane
          ? () => {
              setMenuError(null);
              setConfirmClose(false);
              setMenu({ paneId: pane.id, title: labels.get(pane.id) ?? pane.agent_type });
            }
          : undefined
      }
      onOpen={() => onSelect(pane.id)}
    />
  );

  return (
    <div className="ph-drawer-scrim" data-testid="phone-drawer-scrim" onClick={onClose}>
      <aside
        ref={panelRef}
        className="ph-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={t('phone.drawer.title')}
        data-testid="phone-drawer"
        onClick={(event) => event.stopPropagation()}
        onTouchStart={(event) => {
          const touch = event.touches[0];
          drag.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
        }}
        onTouchMove={(event) => {
          const from = drag.current;
          const touch = event.touches[0];
          if (!from || !touch) return;
          if (from.x - touch.clientX >= SWIPE_OPEN_PX && Math.abs(touch.clientY - from.y) < 40) {
            drag.current = null;
            onClose();
          }
        }}
      >
        <button type="button" className="ph-dsearch" onClick={onSearch} disabled={!bridgeReady}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5" />
            <path d="m16 16 4.5 4.5" />
          </svg>
          <span>{t('phone.search')}</span>
        </button>
        <div className="ph-dscroll">
          {children}
          {waiting.length > 0 && (
            <section aria-label={t('phone.needsYou')}>
              <h2 className="ph-dsec ph-dsec--needs">{t('phone.needsYou')}</h2>
              <ul className="ph-dlist" data-testid="drawer-needs">
                {waiting.map(rowFor)}
              </ul>
            </section>
          )}
          {groups.map((group) => (
            <section key={group.project} aria-label={group.project}>
              <h2 className="ph-dsec">{group.project}</h2>
              <ul className="ph-dlist" data-testid="drawer-project">
                {group.panes.map(rowFor)}
              </ul>
            </section>
          ))}
          {companions.length > 0 && (
            <section aria-label={t('phone.companions')}>
              <h2 className="ph-dsec">{t('phone.companions')}</h2>
              <ul className="ph-dlist">
                {companions.map((companion) => (
                  <li key={companion.id}>
                    <button
                      type="button"
                      className="ph-drow"
                      aria-current={active === companionTab(companion.id) ? 'true' : undefined}
                      onClick={() => onSelect(companionTab(companion.id))}
                    >
                      <span className="ph-drow-icon">
                        <Avatar id={companion.avatar} size={22} state={companion.state} name={companion.name} />
                      </span>
                      <span className="ph-drow-text">
                        <span className="ph-drow-title">{companion.name}</span>
                        <span className="ph-drow-state">{stateWord(companion.state)}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
        {menu && (
          <div className="ph-rowmenu" role="menu" aria-label={menu.title} data-testid="drawer-row-menu" style={{ top: 96, left: 16 }}>
            {!confirmClose && onStopPane && (
              <button
                type="button"
                role="menuitem"
                autoFocus
                disabled={!!locks?.[menu.paneId]}
                onClick={() => {
                  void onStopPane(menu.paneId).then((refused) => {
                    if (refused) setMenuError(refused);
                    else setMenu(null);
                  });
                }}
              >
                {t('phone.rowmenu.stop')}
              </button>
            )}
            {!confirmClose && onClosePane && (
              <button type="button" role="menuitem" data-danger onClick={() => setConfirmClose(true)}>
                {t('phone.rowmenu.close')}
              </button>
            )}
            {confirmClose && onClosePane && (
              <>
                <p className="ph-rowmenu-ask">{t('phone.header.closeAsk')}</p>
                <button type="button" role="menuitem" autoFocus onClick={() => setConfirmClose(false)}>
                  {t('phone.header.keep')}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  data-danger
                  onClick={() => {
                    onClosePane(menu.paneId);
                    setMenu(null);
                    setConfirmClose(false);
                  }}
                >
                  {t('phone.header.closeYes')}
                </button>
              </>
            )}
            {menuError && (
              <p className="ph-rowmenu-ask" role="alert">
                {menuError}
              </p>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(null);
                setConfirmClose(false);
              }}
            >
              {t('phone.rowmenu.cancel')}
            </button>
          </div>
        )}
        <footer className="ph-dfoot">
          <button type="button" className="ph-dlink" onClick={onOverview} aria-current={active === ALL_TAB ? 'true' : undefined}>
            {t('phone.overview')}
          </button>
          <div className="ph-dpc" role="status">
            <span className={`ph-conn${bridgeReady ? '' : ' ph-conn--off'}`} aria-hidden="true" />
            <span>{bridgeReady ? t('phone.pcOnline') : t('phone.pcConnecting')}</span>
          </div>
          <button type="button" className="ph-dlink" onClick={onSettings}>
            {t('phone.settings')}
          </button>
        </footer>
      </aside>
    </div>
  );
}
