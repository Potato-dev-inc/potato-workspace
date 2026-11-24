// Split view: agent chats side by side (like split editors), up to four as a 2x2 grid. The left side is the selected
// pane, the right side is the pane opened "to the side"; each column can also hold a chat below (split-grid.ts).
// The side with focus is full strength; the others are dimmed.
// The session rail on the right follows the focused side. Each side has its own message box (SessionChatPanel).
import { ErrorBoundary } from '../common/ErrorBoundary';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { twoTypesWording, useT } from '../../i18n';
import { useStandbyHelpers } from '../../lib/standbyHelpers';
import { readyMinionCount } from './standby-rows';
import type { CockpitApi } from '../../hooks/useCockpit';
import { SessionChatPanel, type ScreenAsk } from '../chat/SessionChatPanel';
import { composerBlock } from '../../lib/paneOutbox';
import { ACP_LANE, acpChatApi, quietStrip, runStrip } from '../../lib/acpChat';
import { useHost } from '../../lib/host/context';
import { useAcpChatState } from '../../hooks/useAcpChatState';
import { useAcpStop } from '../../hooks/useAcpStop';
import { AcpConfigChips } from '../chat/AcpConfigChips';
import { useAgentRegistry } from '../../lib/agentRegistry';
import { useLoopGuard } from '../../lib/loop-guard';
import { helperOfLabel } from '../../lib/pane-helpers';
import { bindingHint } from '../../lib/shortcuts';
import { setFocusMode } from '../../lib/focus-mode';
import '../../styles/cockpit-split.css';
import { DockedCards } from './DockedCards';
import { AcpChatDock } from '../chat/AcpChatDock';
import { DotSpinner } from './DotSpinner';
import { SplitDivider } from './SplitDivider';
import { HelperQuestions, helperQuestionIds } from './HelperQuestions';
import { IconClose, IconRail, IconSplitDown } from './Icons';
import { SplitRowDivider } from './SplitRowDivider';
import { dragSourceProps } from '../dnd/dragSourceProps';
import { NO_BELOW, canSplitDown, hasLayout, isStacked, isWide, shownIds, slotIds, type SplitBelow, type SplitColumn, type SplitSlot } from './split-grid';
import { dockItems } from './pane-chrome';
import { spinnerStatus, stateText } from './model';
import { SessionRail } from './rail/SessionRail';
import { commandOwners, helperRows } from './rail/helperRows';
import { useRailLayout } from './rail/useRailLayout';
import { paneHeading } from './titles';

/** Moves the keyboard focus into a side's message box (Ctrl+Alt+Left / Right, see CockpitApp). */
export function focusSideComposer(side: SplitSlot) {
  document.querySelector<HTMLTextAreaElement>(`.ck-split-side[data-split-side="${side}"] textarea`)?.focus();
}

/** The window's width, kept current (the split view turns off below a width, see main-view.ts). */
export function useWindowWidth(): number {
  const [width, setWidth] = useState(() => (typeof window === 'undefined' ? 0 : window.innerWidth));
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}


export function SplitView({
  c,
  leftId,
  rightId,
  focus,
  ratio,
  below = NO_BELOW,
  onFocus,
  onRatio,
  onRows,
  onClose,
  onCloseChat,
  onSplitDown,
}: {
  c: CockpitApi;
  leftId: string;
  rightId: string;
  focus: SplitSlot;
  /** The left side's share of the room (see main-view.ts). The CSS keeps each side at its minimum width. */
  ratio: number;
  /** The chats below the two top ones (split-grid.ts). None: the two-chat split. */
  below?: SplitBelow;
  onFocus: (side: SplitSlot) => void;
  onRatio: (ratio: number) => void;
  /** A column's top chat share of its height was dragged. */
  onRows?: (column: SplitColumn, rows: number) => void;
  /** Ends the whole split view. */
  onClose: () => void;
  /** Takes one chat out of the view (the agent keeps running). Without it a chat has no close button of its own. */
  onCloseChat?: (slot: SplitSlot) => void;
  /** Opens another chat below a column. Without it the Split down button is not shown. */
  onSplitDown?: (column: SplitColumn) => void;
}) {
  const t = useT();
  const { view: standbyView } = useStandbyHelpers();
  const rail = useRailLayout();
  const colsRef = useRef<HTMLDivElement>(null);
  const ids = slotIds(leftId, rightId, below);
  const focusedId = ids[focus] ?? leftId;
  const fp = c.registry.panes.get(focusedId);
  const agentName = c.names.get(focusedId) ?? fp?.info.agent_type ?? '';
  const listing = useAgentRegistry();
  const agentType = fp?.info.agent_type ?? '';
  const chatAllowed = listing.agents.find((a) => a.id === agentType)?.kind !== 'shell';
  const shown = shownIds(leftId, rightId, below).length;
  const grid = hasLayout(below);
  const stacked = isStacked(below);
  const wide = isWide(below);
  const wideRef = useRef<HTMLDivElement>(null);
  const railToggle = rail.fits ? (
    <button
      type="button"
      className="ck-icon-btn"
      aria-label={rail.open ? t('pane.railHide') : t('pane.railShow')}
      aria-pressed={rail.open}
      title={rail.open ? t('pane.railHideTip') : t('pane.railShowTip')}
      onClick={rail.toggle}
    >
      <IconRail />
    </button>
  ) : null;
  const column = (col: SplitColumn) => {
    const top = col === 'left' ? leftId : rightId;
    // Two stacked chats share one column: the second sits below the first (its slot is "right"). With a full-width chat
    // at the bottom, the two columns on top hold one chat each.
    const down = stacked ? rightId : wide ? null : col === 'left' ? below.leftDown : below.rightDown;
    return (
      <SplitColumnView
        c={c}
        column={col}
        topId={top}
        downId={down}
        stackedPair={stacked}
        rows={col === 'left' ? below.leftRows : below.rightRows}
        focus={focus}
        grid={grid}
        canSplitDown={!!onSplitDown && canSplitDown(below, col, shown)}
        onFocus={onFocus}
        onRows={(rows) => onRows?.(col, rows)}
        onClose={onClose}
        onCloseChat={onCloseChat}
        onSplitDown={onSplitDown}
        topActions={col === 'right' || stacked ? railToggle : null}
      />
    );
  };
  return (
    <div className="ck-split">
      {stacked ? (
        <div className="ck-split-cols">{column('left')}</div>
      ) : wide && below.leftDown !== null ? (
        <div ref={wideRef} className="ck-split-wide" data-testid="split-wide">
          <div className="ck-split-wide-top" style={{ ['--ck-split-rows' as string]: String(below.leftRows) } as CSSProperties}>
            <div ref={colsRef} className="ck-split-cols" style={{ ['--ck-split-ratio' as string]: String(ratio) } as CSSProperties}>
              {column('left')}
              <SplitDivider colsRef={colsRef} ratio={ratio} onRatio={onRatio} />
              {column('right')}
            </div>
          </div>
          <SplitRowDivider colRef={wideRef} rows={below.leftRows} onRows={(rows) => onRows?.('left', rows)} label={t('split.rowResize')} />
          <ErrorBoundary where="Pane" resetKeys={[below.leftDown]}>
            <SplitSideView
              c={c}
              paneId={below.leftDown}
              side="leftDown"
              focused={focus === 'leftDown'}
              onFocus={onFocus}
              onClose={onClose}
              closeChat={onCloseChat ? () => onCloseChat('leftDown') : undefined}
            />
          </ErrorBoundary>
        </div>
      ) : (
        <div ref={colsRef} className="ck-split-cols" style={{ ['--ck-split-ratio' as string]: String(ratio) } as CSSProperties}>
          {column('left')}
          <SplitDivider colsRef={colsRef} ratio={ratio} onRatio={onRatio} />
          {column('right')}
        </div>
      )}
      {rail.visible && fp && (
        <SessionRail
          paneId={focusedId}
          status={fp.status}
          agentType={fp.info.agent_type}
          cwd={fp.info.cwd}
          agentName={agentName}
          accountLabel={fp.info.account_label}
          readsChat={chatAllowed}
          helperOf={helperOfLabel(c.registry.paneList, focusedId, (p) => paneHeading(p.info, c.names.get(p.info.id) ?? p.info.agent_type).primary)}
          helpers={helperRows(c.registry.paneList, focusedId, (p) => c.names.get(p.info.id) ?? p.info.agent_type)}
          readyMinions={readyMinionCount(standbyView.helpers, c.registry.paneList, focusedId, twoTypesWording())}
          owners={commandOwners(c.registry.paneList, focusedId, (p) => c.names.get(p.info.id) ?? p.info.agent_type)}
          onOpenPane={(id) => c.select(id)}
          onClose={rail.close}
          onStopHelper={(id) => c.interrupt(id)}
        />
      )}
    </div>
  );
}

/** One column of the split: its top chat, and (when there is one) a divider and the chat below. */
function SplitColumnView({
  c,
  column,
  topId,
  downId,
  stackedPair = false,
  rows,
  focus,
  grid,
  canSplitDown: canDown,
  onFocus,
  onRows,
  onClose,
  onCloseChat,
  onSplitDown,
  topActions,
}: {
  c: CockpitApi;
  column: SplitColumn;
  topId: string;
  downId: string | null;
  /** Two stacked chats: the column is the whole width and its second chat is the "right" slot. */
  stackedPair?: boolean;
  rows: number;
  focus: SplitSlot;
  grid: boolean;
  canSplitDown: boolean;
  onFocus: (side: SplitSlot) => void;
  onRows: (rows: number) => void;
  onClose: () => void;
  onCloseChat?: (slot: SplitSlot) => void;
  onSplitDown?: (column: SplitColumn) => void;
  topActions: ReactNode;
}) {
  const t = useT();
  const colRef = useRef<HTMLDivElement>(null);
  const downSlot: SplitSlot = stackedPair ? 'right' : column === 'left' ? 'leftDown' : 'rightDown';
  const side = (slot: SplitSlot, paneId: string, actions?: ReactNode, splitDown?: boolean, top?: boolean) => (
    <ErrorBoundary where="Pane" resetKeys={[paneId]}>
      <SplitSideView
        c={c}
        paneId={paneId}
        side={slot}
        focused={focus === slot}
        onFocus={onFocus}
        onClose={onClose}
        // The two-chat split keeps its one close button (on the right side, closing the whole split). Once there are
        // more chats, every chat has its own close button.
        closeChat={grid && onCloseChat ? () => onCloseChat(slot) : undefined}
        onSplitDown={splitDown && onSplitDown ? () => onSplitDown(column) : undefined}
        stacked={top && downId !== null}
        actions={actions}
      />
    </ErrorBoundary>
  );
  return (
    <div
      ref={colRef}
      className={`ck-split-col ck-split-col-${column}${downId !== null ? ' has-down' : ''}${stackedPair ? ' ck-split-col--full' : ''}`}
      style={{ ['--ck-split-rows' as string]: String(rows) } as CSSProperties}
    >
      {side(column, topId, topActions, canDown, true)}
      {downId !== null && (
        <>
          <SplitRowDivider colRef={colRef} rows={rows} onRows={onRows} label={t('split.rowResize')} />
          {side(downSlot, downId)}
        </>
      )}
    </div>
  );
}

function SplitSideView({
  c,
  paneId,
  side,
  focused,
  onFocus,
  onClose,
  closeChat,
  onSplitDown,
  stacked,
  actions,
}: {
  c: CockpitApi;
  paneId: string;
  side: SplitSlot;
  focused: boolean;
  onFocus: (side: SplitSlot) => void;
  onClose: () => void;
  /** Takes this chat out of the view (shown on every chat once the split has more than two). */
  closeChat?: () => void;
  onSplitDown?: () => void;
  /** Another chat sits below this one: this chat takes its share of the column height. */
  stacked?: boolean;
  /** Extra header buttons (the right side holds the rail toggle and the close button). */
  actions?: ReactNode;
}) {
  const t = useT();
  const pane = c.registry.panes.get(paneId);
  const listing = useAgentRegistry();
  const { signals } = useLoopGuard();
  const [dockIx, setDockIx] = useState(0);
  // A chat session keeps its settings chips (mode, model, effort) and Stop in a split, as in the single view.
  const host = useHost();
  const acp = useMemo(() => acpChatApi(host), [host]);
  const isAcp = pane?.info.lane === ACP_LANE;
  const acpState = useAcpChatState(paneId, isAcp, acp);
  const acpStop = useAcpStop(paneId, !!acpState?.turnInFlight, acp);
  if (!pane) return <div className="ck-split-side" />;

  const { info } = pane;
  const name = c.names.get(paneId) ?? info.agent_type;
  const heading = paneHeading(info, name);
  const chatAllowed = listing.agents.find((a) => a.id === info.agent_type)?.kind !== 'shell';
  const prompt = c.prompts[paneId];
  const waiting = pane.status === 'waiting_input';
  // The same cards the Chat tab shows under the conversation, in the same order (see PaneView).
  const asking = waiting && !!prompt && prompt.choices.length > 0;
  const dock = dockItems(asking, !!signals[paneId]);
  const dockNow = dock.length > 0 ? dock[dockIx % dock.length] : null;
  const helperAsks = helperQuestionIds(c, paneId);
  // "Open Terminal" needs the terminal, which only the single-pane view has: close the split and open this pane.
  const openAlone = () => {
    onClose();
    c.select(paneId);
  };
  // The card for a question only the terminal screen holds (also the safety net for an idle pane with a menu).
  const screenAsk: ScreenAsk = {
    waiting,
    idle: pane.status === 'idle',
    running: pane.status === 'running',
    covered: asking || isAcp,
    fallbackText: prompt?.summary || prompt?.risk?.headline,
    onOpenTerminal: () => openAlone(),
  };
  const chatDock =
    dockNow || helperAsks.length > 0 || isAcp ? (
      <>
        {isAcp && <AcpChatDock c={c} paneId={paneId} paneName={name} api={acp} stopper={acpStop} />}
        <HelperQuestions c={c} ids={helperAsks} />
        {dockNow && <DockedCards c={c} paneId={paneId} dock={dock} dockNow={dockNow} onMore={() => setDockIx((i) => i + 1)} />}
      </>
    ) : null;

  return (
    <section
      className={`ck-split-side${side === 'left' ? ' ck-split-side-left' : ''}${stacked ? ' ck-split-side-top' : ''}${focused ? ' is-focused' : ' is-dim'}`}
      data-split-side={side}
      aria-label={t('split.chatAt', { place: t(`split.place.${side}`), name: heading.primary })}
      aria-current={focused ? 'true' : undefined}
      onMouseDownCapture={() => onFocus(side)}
      onFocusCapture={() => onFocus(side)}
    >
      <header
        className="ck-split-head"
        {...dragSourceProps({ kind: 'tab', id: paneId, label: heading.primary })}
        onDoubleClick={(e) => {
          // Double-click on the header (not on a button) fills the window with this side.
          if ((e.target as HTMLElement).closest('button')) return;
          onFocus(side);
          setFocusMode(true);
        }}
      >
        <DotSpinner status={spinnerStatus(pane.status)} />
        <span className="ck-split-title">{heading.primary}</span>
        <span className="ck-split-state">{waiting ? 'Needs you' : stateText(pane.status)}</span>
        {actions}
        {onSplitDown && (
          <button type="button" className="ck-icon-btn" aria-label={t('split.down')} title={`${t('split.down')}${bindingHint('split-down')}`} onClick={onSplitDown}>
            <IconSplitDown />
          </button>
        )}
        {closeChat ? (
          <button type="button" className="ck-icon-btn" aria-label={t('split.closeChat')} title={`${t('split.closeChat')}${bindingHint('split-close-side')}`} onClick={closeChat}>
            <IconClose />
          </button>
        ) : side === 'right' && (
          <button type="button" className="ck-icon-btn" aria-label={t('r9.split.close')} title={`${t('r9.split.close')}${bindingHint('split')}`} onClick={onClose}>
            <IconClose />
          </button>
        )}
      </header>
      <div className="ck-scroll ck-fade-in ck-split-body">
        <SessionChatPanel
          paneId={paneId}
          dock={chatDock ?? undefined}
          screenAsk={screenAsk}
          reply={{
            blockedReason: composerBlock(pane, !chatAllowed, isAcp),
            running: isAcp ? !!acpState?.turnInFlight : undefined,
            onStop: isAcp ? acpStop.stop : undefined,
            status: isAcp && !quietStrip(acpState, acpStop.asked) ? runStrip(acpState, acpStop.asked) : null,
            onInterrupt: isAcp ? () => void acp.cancel(paneId).catch(() => undefined) : undefined,
          }}
          composerTop={isAcp ? <AcpConfigChips paneId={paneId} state={acpState} api={acp} /> : undefined}
          slashCommands={isAcp ? acpState?.commands : undefined}
          slashAgent={isAcp ? (acpState?.agent || info.agent_type) : undefined}
          emptyNote={chatAllowed ? undefined : 'A plain shell has no chat. Open it alone to use its terminal.'}
          onOpenPane={(id) => c.select(id)}
        />
      </div>
    </section>
  );
}
