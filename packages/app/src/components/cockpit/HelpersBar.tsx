// The helpers bar: one bar above the whole work area (it stays in split view and follows the focused chat).
// Main agents live in the sidebar. The bar holds a way back to the agent in front (the crumb), the helpers that agent
// started, and the person's standby helpers. No helpers and no standbys: nothing is drawn.
// Nothing here names an agent: logos come from the registry, states from the pane status.
import { useDismissable } from '../../hooks/useDismissable';
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { CockpitApi } from '../../hooks/useCockpit';
import { isBusyStatus } from '../../lib/close-policy';
import { useT } from '../../i18n';
import { requestPaneAction } from '../../lib/pane-actions';
import { usePaneTabOrder } from '../../lib/paneTabOrder';
import { useStandbys, type Standby } from '../../lib/helper-standbys';
import { openNewStandby, tauriStandbyHelpersApi } from '../../lib/standbyHelpers';
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
}) {
  const t = useT();
  const live = useStandbys();
  const list = c.registry.paneList;
  const rootId = rootPaneId(list, focusedId);
  const root = list.find((p) => p.info.id === rootId);
  const key = folderKey(root?.info.cwd) ?? '';
  // Only the standbys for the project in front (one with no project shows everywhere).
  const parked = (standbys ?? live).filter((s) => !s.project || !key || folderKey(s.project) === key);
  const { order, setOrder } = usePaneTabOrder(`helpers:${rootId}:${key}`);
  const barRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  useEffect(() => {
    const el = barRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(el.getBoundingClientRect().width));
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  });
  const menuRef = useRef<HTMLDivElement>(null);
  // The chip menu closes on a press outside it, Escape, focus leaving or the page scrolling (one shared rule).
  useDismissable(menu !== null, { inside: [menuRef], onDismiss: () => setMenu(null) });

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
      <div key={`standby-${s.id}`} className="ck-hchip is-standby" data-testid="standby-chip" data-state={busy ? 'working' : 'ready'}>
        <span className="ck-hchip-main" role="tab" aria-selected={false} tabIndex={0} title={tip}>
          <AgentLogo id={s.agent} name={s.name} size={14} decorative />
          <span className="ck-hchip-name">{s.name}</span>
          {busy ? (
            <span className="ck-hchip-dot is-working" role="img" aria-label={t('pane.working')} />
          ) : (
            <>
              <span className="ck-hchip-ring" aria-hidden="true" />
              <span className="ck-hchip-word is-ready">{t('hbar.ready')}</span>
            </>
          )}
        </span>
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
            <span className="ck-hbar-grp">{t('hbar.standby')}</span>
            {parked.map(standbyChip)}
          </>
        )}
      </ReorderList>
      <button type="button" className="ck-hchip ck-hchip-more" data-testid="standby-add" aria-label={t('standby.barAddAria')} onClick={() => openNewStandby(root.info.cwd)}>
        {t('standby.barAdd')}
      </button>
      {menu && (
        <div ref={menuRef} className="ck-menu ck-menu--fixed ck-menu--compact ck-hbar-menu" role="menu" style={{ left: menu.x, top: menu.y }} onPointerDown={(e) => e.stopPropagation()} data-testid="helpers-menu">
          {menu.more
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
                  label: t('standby.makeFromHelper'),
                  run: () => {
                    const p = list.find((x) => x.info.id === menu.id);
                    if (p) void tauriStandbyHelpersApi.add({ name: titleOf(menu.id), agent: p.info.agent_type, model: null, project: p.info.cwd ?? '', after_task: 'wait' }).catch(() => openNewStandby(p.info.cwd));
                  },
                },
              ].flatMap((m) =>
                m ? [
                  <button key={m.key} type="button" role="menuitem" className="ck-menu-item" onClick={() => { setMenu(null); m.run(); }}>
                    <span>{m.label}</span>
                  </button>,
                ] : [],
              )}
        </div>
      )}
    </div>
  );
}
