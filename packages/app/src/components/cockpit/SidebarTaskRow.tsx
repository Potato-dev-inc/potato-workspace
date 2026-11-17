// A background task shown as a row in the sidebar: a minion (logo, name, state, tag "minion") or a command an agent left running
// (pulsing dot, name, ports, time, tag "command"). It is the same task as the one in Background tasks: it still belongs to the
// agent that started it and stops with it. Selected, the main area shows its read-only view. Drag it back to Background tasks,
// or use the menu: Detach / Put back under, Back to Background tasks, Hand to..., Stop or Close. Delete closes it.
import { useRef, useState, type KeyboardEvent } from 'react';
import { useT } from '../../i18n';
import { dragSourceProps } from '../dnd/dragSourceProps';
import { AgentLogo } from '../common/AgentLogo';
import { FloatingMenu } from './FloatingMenu';
import { IconMore } from './Icons';
import type { TaskPlacement } from '../../lib/task-sidebar';
import '../../styles/cockpit-taskdrag.css';

export type TaskState = 'running' | 'waiting_input' | 'done' | 'failed';

export interface TaskRowActions {
  open: (row: TaskPlacement) => void;
  /** On its own <-> under its agent. */
  detach: (row: TaskPlacement) => void;
  putBack: (row: TaskPlacement) => void;
  back: (row: TaskPlacement) => void;
  hand: (row: TaskPlacement, toId: string) => void;
  /** Stops a running task (the row asks first). */
  stop: (row: TaskPlacement) => Promise<void> | void;
  /** Takes a finished task's row away. */
  close: (row: TaskPlacement) => void;
}

export interface SidebarTaskRowProps {
  row: TaskPlacement;
  state: TaskState;
  agentType?: string | null;
  /** The agent that owns it ("Claude 1"). */
  ownerName: string;
  /** Nested under its agent: no "↳" line. */
  nested: boolean;
  active: boolean;
  /** Elapsed time text ("1m 20s"), when it runs. */
  time?: string;
  ports?: readonly number[];
  /** The other agents a minion can be handed to (empty for a command). */
  handTargets: readonly { id: string; name: string }[];
  actions: TaskRowActions;
}

export function SidebarTaskRow({ row, state, agentType, ownerName, nested, active, time, ports = [], handTargets, actions }: SidebarTaskRowProps) {
  const t = useT();
  const anchor = useRef<HTMLElement | null>(null);
  const [menu, setMenu] = useState(false);
  const [asking, setAsking] = useState(false);
  const live = state === 'running' || state === 'waiting_input';
  const isMinion = row.kind === 'minion';
  const tag = t(isMinion ? 'taskdrag.tag.minion' : 'taskdrag.tag.command');
  const tip = [t(isMinion ? 'taskdrag.tip.minion' : 'taskdrag.tip.command', { name: ownerName }), row.command ?? ''].filter(Boolean).join(' · ');

  const close = () => (live ? setAsking(true) : actions.close(row));
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Delete' && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      close();
    }
  };
  const item = (label: string, run: () => void, testid?: string) => (
    <button
      type="button"
      role="menuitem"
      className="ck-menu-item"
      data-testid={testid}
      onClick={() => {
        setMenu(false);
        run();
      }}
    >
      {label}
    </button>
  );

  return (
    <div className="ck-rowwrap ck-taskwrap" data-testid="sidebar-task" data-task-id={row.task_id} data-nested={nested ? 'true' : 'false'}>
      <button
        type="button"
        data-task-row={row.task_id}
        className={`ck-row ck-row--slim ck-taskrow${active ? ' is-active' : ''}${live ? '' : ' is-ended'}${state === 'waiting_input' ? ' is-needs' : ''}${state === 'failed' ? ' is-error' : ''}`}
        onClick={() => actions.open(row)}
        onKeyDown={onKeyDown}
        {...dragSourceProps({ kind: 'bgtask', id: row.task_id, label: row.name, meta: { owner: row.owner, kind: row.kind, ownerName } })}
        onContextMenu={(e) => {
          e.preventDefault();
          anchor.current = e.currentTarget;
          setMenu(true);
        }}
        title={tip}
        aria-current={active ? 'true' : undefined}
      >
        <span className="ck-row-glyph">
          {isMinion ? <AgentLogo id={agentType ?? ''} name={row.name} size={16} decorative /> : <span className={`tdr-dot${live ? ' is-live' : ''}`} aria-hidden="true" />}
        </span>
        <span className="ck-row-main">
          <span className="ck-row-title">{row.name}</span>
          <span className="ck-row-sub">
            {nested ? null : <span className="tdr-owner" data-testid="task-owner-line">{t('taskdrag.row.ownerLine', { name: ownerName })}</span>}
            {ports.map((p) => (
              <span key={p} className="tdr-port">
                :{p}
              </span>
            ))}
          </span>
        </span>
        <span className="tdr-tag" data-testid="task-tag">
          {tag}
        </span>
        {state === 'waiting_input' ? (
          <span className="ck-row-pill">{t('sidebar.needsYou')}</span>
        ) : state === 'failed' ? (
          <span className="ck-row-pill ck-row-pill--error">{t('taskdrag.row.failed')}</span>
        ) : live ? (
          <span className="ck-row-time">{time ?? ''}</span>
        ) : (
          <span className="ck-row-time">{t('taskdrag.row.done')}</span>
        )}
      </button>
      <button
        type="button"
        className="ck-row-more"
        aria-label={t('taskdrag.row.more', { name: row.name })}
        title={t('taskdrag.row.moreTip')}
        aria-haspopup="menu"
        onClick={(e) => {
          anchor.current = e.currentTarget;
          setMenu(true);
        }}
      >
        <IconMore />
      </button>
      {asking && (
        <div className="tdr-ask" role="group" aria-label={t('taskdrag.row.stopAsk', { name: row.name })}>
          <span>{t('taskdrag.row.stopAsk', { name: row.name })}</span>
          <button
            type="button"
            className="ck-btn ck-btn--sm ck-btn--primary"
            autoFocus
            data-testid="task-stop-yes"
            onClick={() => {
              setAsking(false);
              void actions.stop(row);
            }}
          >
            {t('rail.bg.yes')}
          </button>
          <button type="button" className="ck-btn ck-btn--sm ck-btn--plain" onClick={() => setAsking(false)}>
            {t('rail.bg.no')}
          </button>
        </div>
      )}
      {menu && (
        <FloatingMenu anchorRef={anchor} align="start" label={t('taskdrag.menu.label')} onClose={() => setMenu(false)}>
          {nested ? item(t('taskdrag.menu.detach'), () => actions.detach(row), 'task-menu-detach') : item(t('taskdrag.menu.putBack', { name: ownerName }), () => actions.putBack(row), 'task-menu-putback')}
          {item(t('taskdrag.menu.back'), () => actions.back(row), 'task-menu-back')}
          {isMinion && handTargets.map((to) => item(t('taskdrag.menu.handTo', { name: to.name }), () => actions.hand(row, to.id), `task-menu-hand-${to.id}`))}
          {live ? item(t('taskdrag.menu.stop'), close, 'task-menu-stop') : item(t('taskdrag.menu.close'), close, 'task-menu-close')}
        </FloatingMenu>
      )}
    </div>
  );
}
