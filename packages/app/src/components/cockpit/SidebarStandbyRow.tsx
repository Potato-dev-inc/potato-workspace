// One standby helper in the sidebar, under its home agent. States: Ready, Working, With you, Starting, Resting, Can't start.
// On hover the state word gives way to an X (remove, with Undo). Right-click or the "..." button: the row menu.
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useDismissable } from '../../hooks/useDismissable';
import { useT, type MessageKey } from '../../i18n';
import { tauriModelOptionsApi, useModelOptions, type ModelOptionsApi } from '../../lib/modelOptions';
import type { AfterTask } from '../../lib/standbyHelpers';
import { AgentLogo } from '../common/AgentLogo';
import { IconClose, IconMore } from './Icons';
import type { StandbyRow } from './standby-rows';
import '../../styles/standby-rows.css';

export interface StandbyRowActions {
  open: (row: StandbyRow) => void;
  /** "Remove from the agent": the helper keeps running as a free warm agent. */
  detach: (row: StandbyRow) => void;
  /** "Close": the helper stops and goes. */
  close: (row: StandbyRow) => void;
  rename: (row: StandbyRow, name: string) => void;
  setModel: (row: StandbyRow, model: string | null) => void;
  setAfter: (row: StandbyRow, after: AfterTask) => void;
  moveUnder: (row: StandbyRow, agentId: string) => void;
  start: (row: StandbyRow) => void;
}

const WORD: Record<StandbyRow['state'], MessageKey> = {
  ready: 'standby.state.ready',
  working: 'standby.state.busy',
  withYou: 'standby.state.withYou',
  starting: 'standby.state.starting',
  resting: 'standby.state.asleep',
  problem: 'standby.state.problem',
};
const TIP: Record<StandbyRow['state'], MessageKey> = {
  ready: 'standby.tipReady',
  working: 'standby.tipWorking',
  withYou: 'standby.tipWithYou',
  starting: 'standby.tipStarting',
  resting: 'standby.tipResting',
  problem: 'standby.tipReady',
};

export function SidebarStandbyRow({
  row,
  agentLabel,
  active,
  movable,
  underTitle = null,
  actions,
  modelApi = tauriModelOptionsApi,
}: {
  row: StandbyRow;
  agentLabel: string;
  active: boolean;
  /** The other agents of the project this helper can move under. */
  movable: ReadonlyArray<{ id: string; title: string }>;
  /** The agent this row hangs under (the menu says "Remove from it"). */
  underTitle?: string | null;
  actions: StandbyRowActions;
  modelApi?: ModelOptionsApi;
}) {
  const t = useT();
  const h = row.helper;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const warm = !!h.warm;
  const stageKey = row.state === 'starting' && h.stage ? (`standby.stage.${h.stage.replace(/ /g, '_')}` as MessageKey) : null;
  const word = stageKey ? t(stageKey) : t(WORD[row.state]);
  const problemNote = row.state === 'problem' && h.note ? t(`standby.note.${h.note}` as MessageKey) : null;
  const tip = problemNote ?? t('standby.tip', { name: h.name, agent: h.model ? `${agentLabel} · ${h.model}` : agentLabel, state: t(TIP[row.state]) });
  const canRemove = row.state !== 'working' && row.state !== 'withYou';
  const leave = () => (warm ? actions.close(row) : actions.detach(row));
  const from = useRef<HTMLElement | null>(null);

  return (
    <div className="ck-rowwrap ck-sb-wrap" data-testid="standby-row" data-state={row.state} data-helper-id={h.id} data-kind={warm ? 'warm' : 'standby'}>
      <button
        type="button"
        className={`ck-row ck-row--slim ck-sb-row${active ? ' is-active' : ''}`}
        aria-current={active ? 'true' : undefined}
        title={tip}
        onClick={() => actions.open(row)}
        onContextMenu={(e) => {
          e.preventDefault();
          from.current = e.currentTarget;
          const r = e.currentTarget.getBoundingClientRect();
          const keyboard = e.clientX === 0 && e.clientY === 0;
          setMenu({ x: keyboard ? r.left + 24 : e.clientX, y: keyboard ? r.bottom - 4 : e.clientY });
        }}
      >
        <span className="ck-row-glyph">
          <AgentLogo id={h.agent} name={agentLabel} size={14} decorative />
        </span>
        <span className="ck-row-main">
          {editing ? (
            <input
              autoFocus
              className="ck-sb-edit"
              aria-label={t('standby.renameAria', { name: h.name })}
              defaultValue={h.name}
              maxLength={40}
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => {
                setEditing(false);
                const name = e.currentTarget.value.trim();
                if (name && name !== h.name) actions.rename(row, name);
              }}
              onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                e.stopPropagation();
                if (e.key === 'Enter') e.currentTarget.blur();
                if (e.key === 'Escape') {
                  e.currentTarget.value = h.name;
                  e.currentTarget.blur();
                }
              }}
            />
          ) : (
            <span className="ck-row-title">{h.name}</span>
          )}
        </span>
        {!warm && (
          <span className="ck-sb-tag" data-testid="standby-tag">
            {t('standby.tag')}
          </span>
        )}
        <span className={`ck-sb-state is-${row.state}`} data-testid="standby-state">
          {row.state === 'starting' ? <span className="ck-sb-spin" aria-hidden="true" /> : <span className="ck-sb-dot" aria-hidden="true" />}
          <span className="ck-sb-word">{word}</span>
        </span>
      </button>
      {canRemove && (
        <button type="button" className="ck-sb-x" data-testid="standby-row-x" aria-label={t(warm ? 'standby.rowClose' : 'standby.rowX', { name: h.name })} title={warm ? t('standby.menu.close') : t('standby.menu.removeFrom', { agent: underTitle ?? t('standby.agentNow') })} onClick={leave}>
          <IconClose />
        </button>
      )}
      <button
        type="button"
        className="ck-row-more"
        aria-haspopup="menu"
        aria-label={t('sidebar.moreFor', { name: h.name })}
        onClick={(e) => {
          from.current = e.currentTarget;
          const r = e.currentTarget.getBoundingClientRect();
          setMenu({ x: r.left, y: r.bottom + 2 });
        }}
      >
        <IconMore />
      </button>
      {menu && (
        <StandbyRowMenu
          row={row}
          at={menu}
          movable={movable}
          underTitle={underTitle}
          actions={actions}
          modelApi={modelApi}
          onRename={() => setEditing(true)}
          onClose={(refocus) => {
            setMenu(null);
            if (refocus) from.current?.focus();
          }}
        />
      )}
    </div>
  );
}

function StandbyRowMenu({
  row,
  at,
  movable,
  underTitle,
  actions,
  modelApi,
  onRename,
  onClose,
}: {
  row: StandbyRow;
  at: { x: number; y: number };
  movable: ReadonlyArray<{ id: string; title: string }>;
  underTitle: string | null;
  actions: StandbyRowActions;
  modelApi: ModelOptionsApi;
  onRename: () => void;
  onClose: (refocus: boolean) => void;
}) {
  const t = useT();
  const h = row.helper;
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: at.x, top: at.y });
  const options = useModelOptions(h.agent, modelApi);
  const models = options.status === 'ready' ? options.options.models.slice(0, 12) : [];
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ left: Math.max(4, Math.min(at.x, window.innerWidth - r.width - 4)), top: Math.max(4, Math.min(at.y, window.innerHeight - r.height - 4)) });
    el.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [at.x, at.y]);
  useDismissable(true, { inside: [ref], anchor: ref, ignore: ['escape'], onDismiss: () => onClose(false) });

  const onKeyDown = (e: React.KeyboardEvent) => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      onClose(true);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    }
  };
  const item = (label: string, run: () => void, tick = false) => (
    <button key={label} type="button" role="menuitemradio" aria-checked={tick} className="ck-menu-item" tabIndex={-1} onClick={() => (onClose(false), run())}>
      <span className="ck-menu-ic">{tick ? '✓' : ''}</span>
      <span>{label}</span>
    </button>
  );
  const plain = (label: string, run: () => void) => (
    <button key={label} type="button" role="menuitem" className="ck-menu-item" tabIndex={-1} onClick={() => (onClose(false), run())}>
      <span className="ck-menu-ic" />
      <span>{label}</span>
    </button>
  );
  const head = (label: string) => (
    <div key={`h-${label}`} className="ck-sb-menuhead" role="presentation">
      {label}
    </div>
  );
  const scope = document.querySelector('.cockpit') ?? document.body;
  return createPortal(
    <div ref={ref} className="ck-menu ck-menu--fixed ck-menu--compact" role="menu" data-testid="standby-row-menu" aria-label={h.name} style={{ left: pos.left, top: pos.top }} onKeyDown={onKeyDown} onContextMenu={(e) => e.preventDefault()}>
      {plain(t('standby.menu.open'), () => actions.open(row))}
      {plain(t('standby.menu.rename'), onRename)}
      {(row.state === 'resting' || row.state === 'problem') && plain(t('standby.menu.start'), () => actions.start(row))}
      {models.length > 0 && head(t('standby.menu.model'))}
      {models.length > 0 && item(t('models.agentDefault'), () => actions.setModel(row, null), !h.model)}
      {models.map((m) => item(m, () => actions.setModel(row, m), h.model?.toLowerCase() === m.toLowerCase()))}
      {head(t('standby.menu.after'))}
      {item(t('standby.after.wait'), () => actions.setAfter(row, 'wait'), h.after_task === 'wait')}
      {item(t('standby.after.close'), () => actions.setAfter(row, 'close'), h.after_task === 'close')}
      {movable.length > 0 && head(h.warm ? t('standby.menu.makeFor') : t('standby.menu.move'))}
      {movable.map((a) => plain(a.title, () => actions.moveUnder(row, a.id)))}
      <div className="ck-menu-sep" role="separator" />
      {!h.warm && plain(t('standby.menu.removeFrom', { agent: underTitle ?? t('standby.agentNow') }), () => actions.detach(row))}
      {plain(t('standby.menu.close'), () => actions.close(row))}
    </div>,
    scope,
  );
}
