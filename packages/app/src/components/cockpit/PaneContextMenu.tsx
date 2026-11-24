import { useState } from 'react';
import type { PaneAction } from '../../lib/pane-actions';
import { IconClose, IconInfo, IconPin, IconReflow, IconRename, IconStop } from './Icons';
import { useT } from '../../i18n';
import { useShowTerminals } from '../../lib/showTerminals';
import { Menu } from '../common/Floating';

/**
 * The one menu of a pane: opened by a right-click (or the context-menu key, Shift+F10) on its row in the
 * sidebar. Same look as every other menu of the cockpit (`ck-menu`). Groups: view, then the pane's own
 * actions, then Close. (Copy selection lives in the command palette and the terminal, not here.)
 *
 * It is drawn in a portal on the cockpit root, outside the sidebar, so no ancestor of the row (overflow, filter,
 * transform) can clip it or change what `position: fixed` is relative to. It is clamped to the window and opens
 * upward when there is no room below the pointer.
 */
export function PaneContextMenu({
  x,
  y,
  onSide,
  onLeft,
  onBelow,
  pinned,
  onPin,
  onHandoff,
  onPotato,
  helperOf,
  onHelperOf,
  helperName,
  onMainAgain,
  onPassTask,
  onAddHelper,
  onKeepStandby,
  onAction,
  onInterrupt,
  onClose,
}: {
  x: number;
  y: number;
  /** "Open to the side" (split view). Absent: no such item. */
  onSide?: () => void;
  /** "Open on the left" and "Open below": the keyboard way to what a drag onto the work area does. */
  onLeft?: () => void;
  onBelow?: () => void;
  /** The pane is pinned: the item says Unpin. */
  pinned?: boolean;
  /** Pins or unpins the pane. Absent: no such item. */
  onPin?: () => void;
  /** "Handoff from here": the agent writes HANDOFF.md and a new agent continues from it. Absent: no such item. */
  onHandoff?: () => void;
  /** "Potato, check on this": the companion reads this chat and says what it is doing. Absent: no companion, no item. */
  onPotato?: () => void;
  /** "Make helper of…": the main agents this one could help (the keyboard way to a drag onto a row). Empty or absent: no such item. */
  helperOf?: { id: string; name: string }[];
  onHelperOf?: (parentId: string) => void;
  /** This agent's name, for the picker's label. */
  helperName?: string;
  /** "Make it a main agent again" (only for a helper). Absent: no such item. */
  onMainAgain?: () => void;
  /** "Pass to a teammate…": opens the Pass a task sheet for this chat. Absent: no team, no item. */
  onPassTask?: () => void;
  /** An agent's row: "Add a helper" opens the popover under it. Absent: no such item. */
  onAddHelper?: () => void;
  /** A finished helper's row: "Keep as standby" turns it into a standby helper. Absent: no such item. */
  onKeepStandby?: () => void;
  onAction: (action: PaneAction) => void;
  onInterrupt: () => void;
  /** The menu wants to go away (Escape, Tab, a click outside). `refocus` when the keyboard closed it. */
  onClose: (refocus: boolean) => void;
}) {
  const t = useT();
  const terminals = useShowTerminals();
  // "Make helper of…" swaps the menu for the list of agents to pick from. The menu remounts on the swap, so the first item gets the focus.
  const [picking, setPicking] = useState(false);

  // Home and End jump to the ends of the list. The arrows, Escape and Tab are the shared Menu's.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    if (e.key === 'Home') {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1]?.focus();
    }
  };

  const item = (label: string, icon: JSX.Element | null, run: () => void, kbd?: string, keepOpen = false) => (
    <button
      type="button"
      role="menuitem"
      className="ck-menu-item"
      tabIndex={-1}
      onClick={() => {
        if (!keepOpen) onClose(false);
        run();
      }}
    >
      <span className="ck-menu-ic">{icon}</span>
      <span>{label}</span>
      {kbd && <kbd className="ck-chip-key ck-kbd">{kbd}</kbd>}
    </button>
  );

  const menu = (
    <Menu
      key={picking ? 'picking' : 'main'}
      point={{ x, y }}
      align="start"
      className="ck-menu--compact"
      label={t('sidebar.paneActions')}
      onContextMenu={(e) => e.preventDefault()}
      onClose={(back) => onClose(back)}
    >
      <div onKeyDown={onKeyDown}>
      {picking && helperOf ? (
        <div role="group" aria-label={t('adopt.menuLabel', { name: helperName ?? '' })}>
          {helperOf.map((target) => <span key={target.id} style={{ display: 'contents' }}>{item(target.name, null, () => onHelperOf?.(target.id))}</span>)}
        </div>
      ) : (
      <>
      {onSide && (
        <>
          {item(t('sidebar.openToSide'), null, onSide)}
          {onLeft && item(t('dnd.openLeft'), null, onLeft)}
          {onBelow && item(t('dnd.openBelow'), null, onBelow)}
          <div className="ck-menu-sep" role="separator" />
        </>
      )}
      {onPin && item(pinned ? t('sidebar.unpin') : t('sidebar.pin'), <IconPin />, onPin)}
      {helperOf && helperOf.length > 0 && item(t('adopt.menu'), null, () => setPicking(true), undefined, true)}
      {onMainAgain && item(t('adopt.mainAgain'), null, onMainAgain)}
      {item(t('sidebar.rename'), <IconRename />, () => onAction('rename'))}
      {terminals && item(t('sidebar.reflow'), <IconReflow />, () => onAction('reflow'))}
      {item(t('sidebar.interrupt'), <IconStop />, onInterrupt, '⌃C')}
      {onHandoff && item(t('sidebar.handoffFromHere'), null, onHandoff)}
      {onAddHelper && item(t('standby.addTitle'), null, onAddHelper)}
      {onKeepStandby && item(t('standby.keep'), null, onKeepStandby)}
      {onPotato && item(t('potato.check.menu'), null, onPotato)}
      {onPassTask && item(t('teamHub.pass.menu'), null, onPassTask)}
      {item(t('sidebar.details'), <IconInfo />, () => onAction('details'))}
      <div className="ck-menu-sep" role="separator" />
      {item(t('sidebar.close'), <IconClose />, () => onAction('close'))}
      </>
      )}
      </div>
    </Menu>
  );
  return menu;
}
