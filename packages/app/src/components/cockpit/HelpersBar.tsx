// The helpers bar: one bar above the whole work area (it stays in split view and follows the focused chat).
// Main agents live in the sidebar. The bar holds a way back to the agent in front (the crumb), the helpers that agent
// started, and the person's standby helpers. No helpers and no standbys: nothing is drawn.
// Nothing here names an agent: logos come from the registry, states from the pane status.
import { Menu } from '../common/Floating';
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { CockpitApi } from '../../hooks/useCockpit';
import { isBusyStatus } from '../../lib/close-policy';
import { useT } from '../../i18n';
import { requestPaneAction } from '../../lib/pane-actions';
import { usePaneTabOrder } from '../../lib/paneTabOrder';
import { useHelpersInSidebar } from '../../lib/helpersInSidebar';
import { setStandbys, useStandbys, type Standby } from '../../lib/helper-standbys';
import { openNewStandby, tauriStandbyHelpersApi, type StandbyHelpersApi } from '../../lib/standbyHelpers';
import { AgentLogo } from '../common/AgentLogo';
import { dragSourceProps } from '../dnd/dragSourceProps';
import { ReorderList } from '../dnd/ReorderList';
import { applyOrder, moveToSlot } from '../dnd/reorder';
import { chipRoom, chipState, helperIdsOf, rootPaneId, splitOverflow, type ChipState } from './helpers-bar-model';
import { folderKey } from './history-model';
import { IconClose } from './Icons';
import { paneHeading } from './titles';
import '../../styles/helpers-bar.css';

export type TabDot = 'working' | 'needs' | 'error' | null;

/** The dot a background chip shows: needs you (orange) wins over working (green); a broken pane is red. */
export function tabDot(status: string, asking: boolean): TabDot {
  if (status === 'error') return 'error';
  if (asking || status === 'waiting_input') return 'needs';
  if (status === 'running') return 'working';
  return null;
}

interface MenuState {
  id: string;
  /** A standby chip's menu (the id is the standby's). */
  standby?: boolean;
  x: number;
  y: number;
  /** A list of chips (the "+N" button) instead of one chip's actions. */
  more?: boolean;
}

export function HelpersBar({
  c,
  focusedId,
  shown,
  onOpen,
  onOpenBeside,
  standbys,
  standbyApi = tauriStandbyHelpersApi,
}: {
  c: CockpitApi;
  /** The chat that has the focus (in a split: the side with the accent line). */
  focusedId: string;
  /** Every chat open in a pane (a chip or the crumb for one of them is lifted). */
  shown: readonly string[];
  /** Click: open this agent in the focused pane. */
  onOpen: (id: string) => void;
  /** "Open beside" in a chip's menu. */
  onOpenBeside?: (id: string) => void;
  /** Tests: the standbys to draw (default: the live list). */
  standbys?: readonly Standby[];
  /** Tests: where "Remove standby" goes. */
  standbyApi?: StandbyHelpersApi;
}) {
  const t = useT();
  const live = useStandbys();
  const list = c.registry.paneList;
  const rootId = rootPaneId(list, focusedId);
  const root = list.find((p) => p.info.id === rootId);
  const key = folderKey(root?.info.cwd) ?? '';
  // Only the standbys for the project in front (one with no project shows everywhere).
  // With the sidebar list on, the sidebar shows the standbys under their agents; the bar then holds only what the sidebar does not.
  const [inSidebar] = useHelpersInSidebar();
  const parked = inSidebar && !standbys ? [] : (standbys ?? live).filter((s) => !s.project || !key || folderKey(s.project) === key);
  const { order, setOrder } = usePaneTabOrder(`helpers:${rootId}:${key}`);
  const barRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  // A standby the person just removed, for the Undo bar (5 s).
  const [removed, setRemoved] = useState<Standby | null>(null);
  useEffect(() => {
    if (!removed) return;
    const timer = window.setTimeout(() => setRemoved(null), 5000);
    return () => window.clearTimeout(timer);
  }, [removed]);
  const removeStandby = (s: Standby) => {
    // Gone from the bar at once; the backend closes its waiting session.
    setStandbys(live.filter((x) => x.id !== s.id));
    setRemoved(s);
    void standbyApi.remove(s.id).catch(() => {});
  };
  const undoRemove = () => {
    if (!removed) return;
    const s = removed;
    setRemoved(null);
    void standbyApi.add({ name: s.name, agent: s.agent, model: s.model ?? null, project: s.project ?? '', after_task: 'wait' }).catch(() => {});
  };
  useEffect(() => {
    const el = barRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(el.getBoundingClientRect().width));
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  });

  const helperIds = applyOrder(helperIdsOf(list, rootId), (id) => id, order);
  if (!root || (helperIds.length === 0 && parked.length === 0)) return null;

  const nameOf = (id: string) => c.names?.get(id) ?? list.find((p) => p.info.id === id)?.info.agent_type ?? id;
  const titleOf = (id: string) => {
    const p = list.find((x) => x.info.id === id);
    return p ? paneHeading(p.info, nameOf(id)).primary : id;
  };
  const chips = helperIds.map((id) => {
    const p = list.find((x) => x.info.id === id)!;
    return { id, pane: p, state: chipState(p.status, Boolean(c.prompts?.[id])) };
  });
  const keep = new Set(shown);
  const { shown: visible, more } = splitOverflow(chips, chipRoom(width, parked.length), keep);
  const ids = chips.map((x) => x.id);
  const moveChip = (id: string, slot: number) => {
    const next = moveToSlot(ids, id, slot);
    if (next.join('|') !== ids.join('|')) setOrder(next);
  };
  const stateWord: Record<ChipState, string> = { working: t('pane.working'), needs: t('pane.needsYou'), done: t('hbar.done'), stopped: t('hbar.stopped') };
  const close = (id: string) => {
    const p = list.find((x) => x.info.id === id);
    if (!p) return;
    // A working helper asks first (its own view runs the question); an idle one closes and shows the undo bar.
    if (!(isBusyStatus(p.status) || Boolean(c.prompts?.[id]))) return void c.closePane(id);
    c.select(id);
    requestPaneAction(id, 'close');
  };
  const openMenu = (id: string, x: number, y: number) => setMenu({ id, x, y });
  const rootTitle = titleOf(rootId);
  const rootOpen = shown.includes(rootId);

  const helperChip = (chip: (typeof chips)[number]) => {
    const { id, pane, state } = chip;
    const open = shown.includes(id);
    const title = titleOf(id);
    const agent = nameOf(id);
    const tip = `${t('hbar.tipStartedBy', { title, agent, parent: rootTitle })} · ${stateWord[state]}`;
    return (
      <div
        key={id}
        className={`ck-hchip${open ? ' is-on' : ''}`}
        data-pane-tab={id}
        data-state={state}
        onAuxClick={(e: MouseEvent) => {
          if (e.button === 1) {
            e.preventDefault();
            close(id);
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          openMenu(id, e.clientX, e.clientY);
        }}
        {...dragSourceProps({ kind: 'tab', id, label: title })}
      >
        <button
          type="button"
          role="tab"
          aria-selected={open}
          className="ck-hchip-main"
          title={tip}
          onClick={() => onOpen(id)}
          onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => {
            if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              openMenu(id, r.left, r.bottom);
            }
          }}
        >
          <AgentLogo id={pane.info.agent_type} name={agent} size={14} decorative />
          <span className="ck-hchip-name">{title}</span>
          {state === 'working' && <span className="ck-hchip-dot is-working" role="img" aria-label={stateWord.working} data-testid="helper-dot" />}
          {state === 'needs' && (
            <>
              <span className="ck-hchip-dot is-needs" aria-hidden="true" data-testid="helper-dot" />
              <span className="ck-hchip-word is-needs">{stateWord.needs}</span>
            </>
          )}
          {state === 'stopped' && (
            <>
              <span className="ck-hchip-dot is-stopped" aria-hidden="true" data-testid="helper-dot" />
              <span className="ck-hchip-word is-stopped">{stateWord.stopped}</span>
            </>
          )}
          {state === 'done' && (
            <svg className="ck-hchip-check" viewBox="0 0 16 16" role="img" aria-label={stateWord.done} data-testid="helper-check">
              <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
        <button type="button" className="ck-hchip-x" aria-label={t('hbar.close', { title })} onClick={() => close(id)}>
          <IconClose />
        </button>
      </div>
    );
  };

  const standbyChip = (s: Standby) => {
    const busy = s.state === 'busy';
    const tip = t('hbar.tipStandby', { name: s.name, agent: s.model ? `${s.agent} · ${s.model}` : s.agent });
    return (
      <div
        key={`standby-${s.id}`}
        className="ck-hchip is-standby"
        data-testid="standby-chip"
        data-state={busy ? 'working' : s.state === 'starting' ? 'starting' : 'ready'}
        onContextMenu={(e: MouseEvent) => {
          e.preventDefault();
          setMenu({ id: s.id, standby: true, x: e.clientX, y: e.clientY });
        }}
      >
        <span className="ck-hchip-main" role="tab" aria-selected={false} tabIndex={0} title={tip}>
          <AgentLogo id={s.agent} name={s.name} size={14} decorative />
          <span className="ck-hchip-name">{s.name}</span>
          {busy ? (
            <span className="ck-hchip-dot is-working" role="img" aria-label={t('pane.working')} />
          ) : s.state === 'starting' ? (
            <span className="ck-hchip-word">{t('hbar.starting')}</span>
          ) : (
            <>
              <span className="ck-hchip-ring" aria-hidden="true" />
              <span className="ck-hchip-word is-ready">{t('hbar.ready')}</span>
            </>
          )}
        </span>
        <button type="button" className="ck-hchip-x" data-testid="standby-remove" aria-label={t('standby.removeAria', { name: s.name })} onClick={() => removeStandby(s)}>
          <IconClose />
        </button>
      </div>
    );
  };

  return (
    <div ref={barRef} className="ck-hbar" data-testid="helpers-bar">
      <ReorderList
        zoneId={`helpers-${rootId}`}
        kind="tab"
        axis="x"
        priority={1}
        className="ck-hbar-in"
        attrs={{ role: 'tablist', 'aria-label': t('hbar.label') }}
        items={(box) =>
          ids.flatMap((id) => {
            const el = box.querySelector(`[data-pane-tab="${id}"]`);
            return el ? [{ id, el }] : [];
          })
        }
        accepts={(p) => ids.includes(p.id)}
        keyboardId={(el) => el.closest('[data-pane-tab]')?.getAttribute('data-pane-tab') ?? null}
        label={titleOf}
        onMove={(id, slot) => moveChip(id, slot)}
      >
        <button
          type="button"
          role="tab"
          aria-selected={rootOpen}
          className={`ck-hcrumb${rootOpen ? ' is-on' : ''}`}
          data-testid="helpers-crumb"
          title={t('hbar.back')}
          aria-label={`${t('hbar.back')}: ${rootTitle}`}
          onClick={() => onOpen(rootId)}
        >
          <AgentLogo id={root.info.agent_type} name={nameOf(rootId)} size={14} decorative />
          <span>{rootTitle}</span>
        </button>
        {chips.length > 0 && <span className="ck-hbar-gt" aria-hidden="true">›</span>}
        {visible.map(helperChip)}
        {more.length > 0 && (
          <button
            type="button"
            className="ck-hchip ck-hchip-more"
            data-testid="helpers-more"
            aria-haspopup="menu"
            aria-label={t('hbar.moreAria', { n: more.length })}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setMenu({ id: '', x: r.left, y: r.bottom, more: true });
            }}
          >
            +{more.length}
          </button>
        )}
        {parked.length > 0 && (
          <>
            <span className="ck-hbar-vsep" aria-hidden="true" />
            {parked.map(standbyChip)}
          </>
        )}
      </ReorderList>
      {!inSidebar && (
        <button
          type="button"
          className="ck-hchip ck-hchip-more"
          data-testid="standby-add"
          aria-label={t('standby.addAria', { name: rootTitle })}
          title={t('standby.addTitle')}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            openNewStandby(root.info.cwd, rootId, { x: r.left, y: r.bottom + 4 });
          }}
        >
          +
        </button>
      )}
      {removed && (
        <div className="ck-hbar-undo" role="status" data-testid="standby-undo">
          <span>{t('standby.removed', { name: removed.name })}</span>
          <button type="button" onClick={undoRemove}>
            {t('standby.undo')}
          </button>
        </div>
      )}
      {menu && (
        <Menu point={{ x: menu.x, y: menu.y }} align="start" className="ck-menu--compact ck-hbar-menu" label={menu.more ? t('hbar.moreAria', { n: more.length }) : titleOf(menu.id)} testId="helpers-menu" onPointerDown={(e) => e.stopPropagation()} onClose={() => setMenu(null)}>
          {menu.standby ? (
            <button
              type="button"
              role="menuitem"
              className="ck-menu-item"
              onClick={() => {
                const s = parked.find((x) => x.id === menu.id);
                setMenu(null);
                if (s) removeStandby(s);
              }}
            >
              <span>{t('standby.removeMenu')}</span>
            </button>
          ) : menu.more
            ? more.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="menuitem"
                  className="ck-menu-item"
                  onClick={() => {
                    setMenu(null);
                    onOpen(m.id);
                  }}
                >
                  <span>{titleOf(m.id)}</span>
                  {m.state === 'needs' && <kbd className="ck-chip-key ck-kbd">{t('pane.needsYou')}</kbd>}
                </button>
              ))
            : [
                onOpenBeside && { key: 'beside', label: t('hbar.openBeside'), run: () => onOpenBeside(menu.id) },
                { key: 'rename', label: t('hbar.rename'), run: () => { c.select(menu.id); requestPaneAction(menu.id, 'rename'); } },
                { key: 'stop', label: t('hbar.stop'), run: () => close(menu.id) },
                chips.find((x) => x.id === menu.id)?.state === 'done' && {
                  key: 'standby',
                  label: t('standby.keep'),
                  run: () => {
                    const p = list.find((x) => x.info.id === menu.id);
                    if (p) void tauriStandbyHelpersApi.add({ name: titleOf(menu.id), agent: p.info.agent_type, model: null, project: p.info.cwd ?? '', after_task: 'wait', home: rootId }).catch(() => openNewStandby(p.info.cwd, rootId));
                  },
                },
              ].flatMap((m) =>
                m ? [
                  <button key={m.key} type="button" role="menuitem" className="ck-menu-item" onClick={() => { setMenu(null); m.run(); }}>
                    <span>{m.label}</span>
                  </button>,
                ] : [],
              )}
        </Menu>
      )}
    </div>
  );
}
