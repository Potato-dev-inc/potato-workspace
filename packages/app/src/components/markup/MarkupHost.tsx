// The mark-up bar around a page: it owns the marks, the keys, the picture and the send. The page (`children`) is drawn
// inside a stage; the layer and the bar float over that stage, so they are the app's own elements (the page cannot see,
// block or fake them). In the artifact pane and in the artifact's own window this is the same component.
//
// Rules held here: nothing is sent by drawing alone (Send needs a click or Enter in the send row); while a mark exists the
// page is held still (v1: marks and picture stay matched) and a pane resize clears the marks with a one-line notice.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useT } from '../../i18n';
import { errorSentence } from '../../lib/sayError';
import type { ArtifactPick } from '../../lib/artifact-point';
import { markupApi, type MarkupAgent, type MarkupApi, type MarkupShot } from '../../lib/markup/api';
import { requestNewAgent } from '../../lib/newAgentRequest';
import {
  addMark,
  canSend,
  clearMarks,
  closeBar,
  composeMarkupMessage,
  countLine,
  escape as escapeStep,
  initialState,
  keyAction,
  openBar,
  openSend,
  probePoint,
  redo,
  scrollHeld,
  setColor,
  setShape,
  setTool,
  togglePopup,
  undo,
  type Hover,
  type Mark,
  type MarkupState,
} from '../../lib/markup/model';
import type { FrameProbe } from '../files/SandboxFrame';
import type { BodyMarkup } from '../artifacts/ArtifactBody';
import { MarkupBar, type BarActions } from './MarkupBar';
import { MarkupLayer } from './MarkupLayer';
import { SendRow } from './SendRow';
import '../../styles/markup.css';

const STATUS_MS = 1800;

const frames = (n: number) =>
  new Promise<void>((resolve) => {
    const step = (left: number) => (left <= 0 ? resolve() : typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => step(left - 1)) : void setTimeout(() => step(left - 1), 16));
    step(n);
  });

const TO_KEY = 'potato.markupTo.v1';
const lastTo = (): string | null => {
  try {
    return localStorage.getItem(TO_KEY);
  } catch {
    return null;
  }
};
const rememberTo = (id: string) => {
  try {
    localStorage.setItem(TO_KEY, id);
  } catch {
    // Storage is blocked: the page's own agent is preselected next time.
  }
};

const typingIn = (el: EventTarget | null): boolean => {
  const n = el as HTMLElement | null;
  if (!n || !n.tagName) return false;
  // The agent list is open: its keys (arrows, Enter, Escape) are its own, not the bar's.
  if (n.closest?.('[role="menu"]')) return true; // a popup in the top layer counts too
  return n.tagName === 'INPUT' || n.tagName === 'TEXTAREA' || n.tagName === 'SELECT' || n.isContentEditable === true;
};

export function MarkupHost({
  open,
  onOpenChange,
  paneId,
  title,
  id,
  version,
  selectDisabled = false,
  api = markupApi,
  onSent,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The chat that owns the page: where Send goes. */
  paneId: string;
  title: string;
  id: string;
  version: number;
  /** A picture has no parts to select (SVG): Select is off and the bar opens on Pen. */
  selectDisabled?: boolean;
  api?: MarkupApi;
  onSent?: () => void;
  /** The page. It gets what the Select tool needs. */
  children: (markup: BodyMarkup) => ReactNode;
}) {
  const t = useT();
  const stage = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<MarkupState>(() => initialState(false));
  const live = useRef(state);
  live.current = state;
  const [hover, setHover] = useState<Hover | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const [shooting, setShooting] = useState(false);
  const [taking, setTaking] = useState(false);
  const [shot, setShot] = useState<MarkupShot | null>(null);
  const [noPicture, setNoPicture] = useState(false);
  const [request, setRequest] = useState('');
  const [needText, setNeedText] = useState(false);
  const [busy, setBusy] = useState(false);
  const [agents, setAgents] = useState<MarkupAgent[] | null>(null);
  const [to, setTo] = useState<string | null>(null);
  const probe = useRef<FrameProbe | null>(null);
  const probed = useRef(new Set<number>());
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const size = useRef({ w: 0, h: 0 });

  const say = useCallback((text: string) => {
    setStatus(text);
    if (statusTimer.current) clearTimeout(statusTimer.current);
    statusTimer.current = setTimeout(() => setStatus(null), STATUS_MS);
  }, []);
  useEffect(() => () => void (statusTimer.current && clearTimeout(statusTimer.current)), []);

  // The header button (or Ctrl+Shift+M) opens and closes the bar.
  useEffect(() => {
    setState((s) => {
      if (open === s.open) return s;
      if (!open) return closeBar(s);
      const o = openBar(s);
      return selectDisabled ? setTool(o, 'pen') : o;
    });
    if (!open) {
      setHover(null);
      setRequest('');
      setShot(null);
      setNoPicture(false);
      probed.current.clear();
    }
    if (open && selectDisabled) say(t('markup.svgNoSelect'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // A new version of the page is a different picture: the marks on the old one are dropped.
  const seenVersion = useRef(version);
  useEffect(() => {
    if (seenVersion.current === version) return;
    seenVersion.current = version;
    if (live.current.marks.length > 0) {
      setState(clearMarks);
      setShot(null);
    }
  }, [version]);

  // Width for the narrow rules, and "a resize clears the marks" (v1).
  useEffect(() => {
    const el = stage.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(() => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      setWidth(w);
      const before = size.current;
      size.current = { w, h };
      if (before.w > 0 && (before.w !== w || before.h !== h) && live.current.marks.length > 0) {
        setState(clearMarks);
        setShot(null);
        say(t('markup.resized'));
      }
    });
    watch.observe(el);
    return () => watch.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const apply = useCallback(
    (fn: (s: MarkupState) => MarkupState) => {
      const next = fn(live.current);
      live.current = next;
      setState(next);
      if (!next.open) onOpenChange(false);
    },
    [onOpenChange],
  );

  const commit = useCallback((mark: Omit<Mark, 'id'>) => apply((s) => addMark(s, mark)), [apply]);
  const heldBefore = useRef(false);
  const held = scrollHeld(state);
  useEffect(() => {
    if (held && !heldBefore.current) say(t('markup.held'));
    heldBefore.current = held;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [held]);

  // ---- the keys ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = typingIn(e.target) || e.isComposing;
      const a = keyAction({ key: e.key, ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey, shift: e.shiftKey, typing }, live.current.open);
      if (!a) return;
      e.preventDefault();
      switch (a.kind) {
        case 'toggle':
          onOpenChange(!live.current.open);
          break;
        case 'tool':
          apply((s) => (a.tool === 'select' && selectDisabled ? s : setTool(s, a.tool)));
          break;
        case 'shape':
          apply((s) => setShape(s, a.shape));
          break;
        case 'undo':
          apply(undo);
          break;
        case 'redo':
          apply(redo);
          break;
        case 'send':
          apply(openSend);
          break;
        case 'escape':
          apply(escapeStep);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [apply, onOpenChange, selectDisabled]);

  // ---- the picture ----
  // While the send row is open the picture matches the marks: it is taken again when the marks change.
  const sig = state.marks.map((m) => m.id).join(',');
  const sending = state.sending && state.open;
  useEffect(() => {
    if (!sending) return;
    let stale = false;
    (async () => {
      setTaking(true);
      setNoPicture(false);
      // Which element does each shape mean? Ask the page (an arrow's tip, the middle of a box, ...).
      const ask = probe.current;
      const todo = live.current.marks.filter((m) => m.type !== 'pick' && !m.near && !probed.current.has(m.id));
      if (ask && todo.length > 0) {
        const found = await Promise.all(
          todo.map(async (m) => {
            probed.current.add(m.id);
            const p = probePoint(m);
            return [m.id, await ask(p.x, p.y).catch(() => null)] as const;
          }),
        );
        if (stale) return;
        const byId = new Map<number, ArtifactPick | null>(found);
        setState((s) => ({ ...s, marks: s.marks.map((m) => (byId.get(m.id) ? { ...m, near: byId.get(m.id) } : m)) }));
      }
      setShooting(true);
      await frames(2);
      try {
        const r = stage.current?.getBoundingClientRect();
        if (!r || r.width <= 0) throw new Error('no stage');
        const res = await api.capture(paneId, { x: r.left, y: r.top, w: r.width, h: r.height }, window.innerWidth);
        if (!stale) setShot(res);
      } catch {
        if (!stale) {
          setShot(null);
          setNoPicture(true);
        }
      } finally {
        setShooting(false);
        if (!stale) setTaking(false);
      }
    })();
    return () => {
      stale = true;
      setShooting(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sending, sig]);

  // Who can get it: the running agents. The page's own agent is picked first, else the one used last, else the newest here.
  const loadAgents = useCallback(async () => {
    if (!api.targets) return;
    try {
      const got = await api.targets(paneId);
      const rows = got.rows;
      setAgents(rows);
      setTo((now) => {
        const keep = (id: string | null) => (id && rows.some((r) => r.id === id && r.ok) ? id : null);
        const mine = rows.some((r) => r.id === paneId && r.ok) ? paneId : null;
        return keep(now) ?? mine ?? keep(lastTo()) ?? keep(got.current) ?? rows.find((r) => r.ok)?.id ?? null;
      });
    } catch {
      setAgents(null);
    }
  }, [api, paneId]);
  useEffect(() => {
    if (sending) void loadAgents();
  }, [sending, loadAgents]);

  const newAgent = () => {
    if (requestNewAgent()) say(t('markup.openedNewAgent'));
    else {
      // This window is not the cockpit (the page's own window): open the cockpit and ask it for the New agent page.
      void Promise.all([import('../../lib/cockpit-api'), import('@tauri-apps/api/event')])
        .then(async ([m, ev]) => {
          await m.cockpitApi.openCockpit();
          setTimeout(() => void ev.emit('cockpit://view', { view: 'newagent' }), 1200);
        })
        .catch(() => undefined);
    }
  };

  const send = async (override?: string) => {
    const s = live.current;
    if (!canSend(s.marks, request)) {
      setNeedText(true);
      return;
    }
    let text: string;
    try {
      text = composeMarkupMessage({ title, id, version, marks: s.marks, request });
    } catch (err) {
      say(errorSentence(err));
      return;
    }
    setBusy(true);
    try {
      const dest = override ?? (agents ? to : null);
      const away = dest && dest !== paneId ? dest : undefined;
      await (away ? api.send(paneId, shot?.shotId ?? null, text, away) : api.send(paneId, shot?.shotId ?? null, text));
      if (dest) rememberTo(dest);
      const who = agents?.find((a) => a.id === dest)?.name;
      setState(clearMarks);
      setRequest('');
      setShot(null);
      setNeedText(false);
      probed.current.clear();
      say(who ? t('markup.sentTo', { agent: who }) : t('markup.sent'));
      onSent?.();
    } catch (err) {
      say(errorSentence(err));
    } finally {
      setBusy(false);
    }
  };

  const actions: BarActions = {
    tool: (tool) => apply((s) => setTool(s, tool)),
    shape: (shape) => apply((s) => setShape(s, shape)),
    color: (color) => apply((s) => setColor(s, color)),
    popup: (popup) => apply((s) => togglePopup(s, popup)),
    closePopup: () => apply((s) => (s.popup ? { ...s, popup: null } : s)),
    undo: () => apply(undo),
    clear: () => {
      apply(clearMarks);
      setShot(null);
      say(t('markup.cleared'));
    },
    send: () => apply(openSend),
    close: () => apply(closeBar),
  };

  const selecting = state.open && state.tool === 'select' && !selectDisabled;
  const bridge = useMemo<BodyMarkup>(
    () => ({
      selecting,
      hold: held,
      stage,
      onHover: setHover,
      onPick: ({ pick, rect }) => {
        if (!rect) return;
        commit({ type: 'pick', color: live.current.color, x1: rect.x, y1: rect.y, x2: rect.x + rect.w, y2: rect.y + rect.h, near: pick });
      },
      registerProbe: (p) => {
        probe.current = p;
      },
    }),
    [selecting, held, commit],
  );

  const counts = countLine(state.marks);
  return (
    <div className="mk-stage" ref={stage} data-testid="markup-stage">
      {children(bridge)}
      {state.open && (
        <>
          <MarkupLayer state={state} hover={hover} shooting={shooting} onDraft={(draft) => setState((s) => ({ ...s, draft }))} onCommit={commit} />
          <div className={`mk-dock${shooting ? ' is-shooting' : ''}`} data-testid="markup-dock">
            {status && (
              <div className="mk-status" role="status" data-testid="markup-status">
                {status}
              </div>
            )}
            {sending && state.marks.length > 0 && (
              <SendRow
                thumb={shot?.thumb ?? null}
                taking={taking}
                noPicture={noPicture}
                marks={counts.marks}
                elements={counts.elements}
                request={request}
                needText={needText}
                busy={busy}
                agents={agents}
                to={to}
                owner={paneId}
                onOpenTo={() => void loadAgents()}
                onNewAgent={newAgent}
                onRequest={(v) => {
                  setRequest(v);
                  setNeedText(false);
                }}
                onSend={(dest) => void send(dest)}
              />
            )}
            <MarkupBar state={state} width={width} actions={actions} selectDisabled={selectDisabled} />
          </div>
        </>
      )}
    </div>
  );
}
