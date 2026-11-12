// "Bring my chats": pick an agent, see its 10 newest chats, pick some or bring a whole time range. It is the content
// only; the caller wraps it in a Sheet (Escape and Tab come from there). Opening it is the person's own press, so it
// looks at the agents' chat folders then and not before. Nothing leaves this computer.
import { errorSentence } from '../../lib/sayError';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { chatIndexSetEnabled } from '../../lib/chatIndex';
import {
  bringingLine,
  doneLine,
  endOfDay,
  failedCount,
  rangeOf,
  RANGE_CHIPS,
  startOfDay,
  whyLines,
  type RangeKey,
} from '../../lib/bringChats';
import {
  chatCount,
  chatImportApi,
  idleProgress,
  onImportProgress,
  requestImportedChat,
  type BrowseRow,
  type ImportApi,
  type ImportFound,
  type ImportProgress,
  type ImportState,
} from '../../lib/chatImport';
import '../../styles/history.css';
import { BringAgentList } from './BringAgentList';
import { BringChatRows } from './BringChatRows';

export const BRING_CHATS_TITLE_ID = 'bc-panel-title';
export const BRING_CHATS_TITLE = 'Bring my chats';
/** The text of the "Remove imported chats" question. The Settings row uses the same words. */
export const BRING_REMOVE_BODY = "This removes the chats Potato Workspace brought in. Your agents' own chat files are not touched.";
/** Chats on a page. */
export const PAGE_SIZE = 10;
/** How often the panel asks for the progress of a run, on top of the events it listens to. */
const POLL_MS = 500;

export function BringChatsPanel({
  api = chatImportApi,
  onClose,
  now = Date.now,
}: {
  api?: ImportApi;
  onClose?: () => void;
  /** The clock, so a test can fix "2 days ago". */
  now?: () => number;
}) {
  const [state, setState] = useState<ImportState | null>(null);
  const [found, setFound] = useState<ImportFound[] | null>(null);
  const [agent, setAgent] = useState<string | null>(null);
  const [rangeKey, setRangeKey] = useState<RangeKey | null>(null);
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [rows, setRows] = useState<BrowseRow[]>([]);
  const [total, setTotal] = useState(0);
  const [more, setMore] = useState(false);
  const [next, setNext] = useState(0);
  const [loadingRows, setLoadingRows] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [progress, setProgress] = useState<ImportProgress>(idleProgress);
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wanted = useRef(0);

  // "Now" is read once, and again when a chip is pressed: a range that moved on every render would reload forever.
  const [when, setWhen] = useState(now);
  const range = useMemo(() => (rangeKey === null ? { fromMs: null, toMs: null } : rangeOf(rangeKey, when, custom)), [rangeKey, when, custom]);
  const customReady = rangeKey !== 'custom' || startOfDay(custom.from) !== null || endOfDay(custom.to) !== null;
  const rangeFrom = range.fromMs;
  const rangeTo = range.toMs;

  const look = useCallback(async () => {
    setError(null);
    try {
      setFound(await api.look(null));
    } catch (e) {
      setError(errorSentence(e));
      setFound([]);
    }
  }, [api]);

  // The saved state first (no folder is read), then one look at the agents when chat search is on.
  useEffect(() => {
    let live = true;
    void api
      .state()
      .then((next) => {
        if (!live) return;
        setState(next);
        setProgress(next.progress);
        if (next.progress.phase === 'reading' || next.progress.phase === 'looking') setWorking(true);
        if (next.indexEnabled) void look();
      })
      .catch((e: unknown) => live && setError(errorSentence(e)));
    const stop = onImportProgress((next) => live && setProgress(next));
    return () => {
      live = false;
      stop();
    };
  }, [api, look]);

  // One page of the chosen agent: ten chats, newest first. A newer ask makes an older answer stale.
  const loadRows = useCallback(
    async (offset: number) => {
      if (!agent) return;
      const ticket = ++wanted.current;
      setLoadingRows(true);
      setError(null);
      try {
        const page = await api.browse(agent, { fromMs: rangeFrom, toMs: rangeTo }, offset, PAGE_SIZE);
        if (ticket !== wanted.current) return;
        setRows((prev) => (offset === 0 ? page.rows : [...prev, ...page.rows]));
        setTotal(page.total);
        setMore(page.more);
        setNext(page.next);
      } catch (e) {
        if (ticket === wanted.current) setError(errorSentence(e));
      } finally {
        if (ticket === wanted.current) setLoadingRows(false);
      }
    },
    [api, agent, rangeFrom, rangeTo],
  );

  useEffect(() => {
    setRows([]);
    setTotal(0);
    setMore(false);
    setPicked(new Set());
    if (agent && customReady) void loadRows(0);
  }, [agent, rangeFrom, rangeTo, customReady, loadRows]);

  // While a run works: ask for its progress now and then (the events can be missed), and show the result at the end.
  useEffect(() => {
    if (!working) return;
    let live = true;
    const timer = setInterval(() => {
      void api
        .state()
        .then((next) => live && setProgress(next.progress))
        .catch(() => undefined);
    }, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [api, working]);

  const finished = progress.phase === 'done' || progress.phase === 'cancelled' || progress.phase === 'failed';
  useEffect(() => {
    if (!working || !finished) return;
    setWorking(false);
    setResult(true);
    void look();
  }, [working, finished, look]);

  const label = (id: string | null): string => found?.find((f) => f.id === id)?.label ?? state?.agents.find((a) => a.id === id)?.label ?? id ?? '';

  const bring = async (sessions: string[] | null) => {
    if (!agent) return;
    setError(null);
    setNotice(null);
    setResult(false);
    setWorking(true);
    setProgress({ ...idleProgress(), phase: 'looking' });
    try {
      setProgress(await api.bring({ agent, sessions, fromMs: sessions ? null : rangeFrom, toMs: sessions ? null : rangeTo }));
      setPicked(new Set());
    } catch (e) {
      setWorking(false);
      setError(errorSentence(e));
    }
  };

  const stop = async () => {
    try {
      setProgress(await api.cancel());
    } catch (e) {
      setError(errorSentence(e));
    }
  };

  const turnOn = async () => {
    setBusy(true);
    try {
      const status = await chatIndexSetEnabled(true);
      setState((prev) => prev && { ...prev, indexEnabled: status.enabled });
      if (status.enabled) void look();
    } catch (e) {
      setError(errorSentence(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setConfirming(false);
    setBusy(true);
    try {
      await api.clear();
      setProgress(idleProgress());
      setResult(false);
      setAgent(null);
      await look();
      setNotice("Brought chats removed. Your agents' own chat files are not touched.");
    } catch (e) {
      setError(errorSentence(e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (session: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (!next.delete(session)) next.add(session);
      return next;
    });

  const chooseChip = (key: RangeKey) => {
    setWhen(now());
    setRangeKey((prev) => (prev === key ? null : key));
  };
  const closeButton = onClose && (
    <button type="button" className="ck-btn ck-btn--plain" onClick={onClose}>
      Close
    </button>
  );

  const view = !state
    ? 'looking'
    : working
      ? 'bringing'
      : result
        ? 'done'
        : !state.indexEnabled
          ? 'off'
          : found === null
            ? 'looking'
            : agent
              ? 'agent'
              : 'agents';

  const failed = failedCount(progress);
  const why = whyLines(progress);
  const chosen = agent ? label(agent) : '';
  const sample = rows.slice(0, 3);
  const rangeCount = rangeKey !== null && customReady ? total : 0;
  const canBring = picked.size > 0 || rangeCount > 0;
  const bringLabel =
    picked.size > 0
      ? `Bring these (${picked.size})`
      : rangeCount > 0
        ? rangeKey === 'all'
          ? `Bring all ${chatCount(total)}`
          : `Bring all ${chatCount(total)} from this range`
        : 'Bring these';

  return (
    <section className="bc-panel" aria-labelledby={BRING_CHATS_TITLE_ID}>
      <h2 className="ck-section" id={BRING_CHATS_TITLE_ID}>
        {BRING_CHATS_TITLE}
      </h2>
      {error && (
        <p className="bc-error" role="alert">
          {error}
        </p>
      )}
      {notice && view !== 'bringing' && (
        <p className="ck-sub" role="status">
          {notice}
        </p>
      )}

      {view === 'looking' && (
        <p className="ck-sub" role="status">
          Looking for your chats…
        </p>
      )}

      {view === 'off' && (
        <>
          <p className="ck-sub">Chat search is off. Turn it on to bring your chats.</p>
          <div className="bc-actions">
            {closeButton}
            <button type="button" className="ck-btn ck-btn--primary" disabled={busy} onClick={() => void turnOn()}>
              Turn on
            </button>
          </div>
        </>
      )}

      {view === 'agents' && found && (
        <>
          <p className="ck-sub">Pick an agent to see its chats on this PC. Nothing leaves this computer.</p>
          <BringAgentList
            found={found}
            unreadable={(state?.agents ?? []).filter((a) => !found.some((f) => f.id === a.id))}
            now={when}
            onPick={(id) => {
              setRangeKey(null);
              setAgent(id);
            }}
          />
          {found.length === 0 && <p className="ck-sub">No agent has chats to bring.</p>}
          <div className="bc-actions">{closeButton}</div>
        </>
      )}

      {view === 'agent' && (
        <>
          <button type="button" className="bc-back" onClick={() => setAgent(null)}>
            ‹ All agents
          </button>
          <p className="ck-sub">{`${chosen}: newest chats first. Pick some, or bring a whole time range.`}</p>
          <div className="bc-chips" role="group" aria-label="Time range">
            {RANGE_CHIPS.map((chip) => (
              <button key={chip.key} type="button" className="bc-chip" aria-pressed={rangeKey === chip.key} onClick={() => chooseChip(chip.key)}>
                {chip.label}
              </button>
            ))}
          </div>
          {rangeKey === 'custom' && (
            <div className="bc-dates">
              <label>
                From <input type="date" aria-label="From date" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
              </label>
              <label>
                To <input type="date" aria-label="To date" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
              </label>
            </div>
          )}
          {loadingRows && rows.length === 0 && (
            <p className="ck-sub" role="status">
              Loading…
            </p>
          )}
          {!loadingRows && rows.length === 0 && customReady && <p className="ck-sub">No chats in this range.</p>}
          {rows.length > 0 && <BringChatRows rows={rows} picked={picked} now={when} onToggle={toggle} onOpen={(session) => agent && requestImportedChat(agent, session)} />}
          {more && (
            <button type="button" className="ck-btn ck-btn--secondary" disabled={loadingRows} onClick={() => void loadRows(next)}>
              Show more
            </button>
          )}
          {rangeCount > 0 && (
            <div className="bc-range">
              <span>{`${chatCount(total)} in this range. A few of them:`}</span>
              <ul aria-label="A few of them">
                {sample.map((row) => (
                  <li key={row.session}>{row.title}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="bc-actions">
            {closeButton}
            {/* One primary button: the picked chats, or else the whole range (when a range chip is on). */}
            <button type="button" className="ck-btn ck-btn--primary" disabled={!canBring} onClick={() => void bring(picked.size > 0 ? [...picked] : null)}>
              {bringLabel}
            </button>
          </div>
        </>
      )}

      {view === 'bringing' && (
        <>
          <p className="ck-sub" role="status">
            {bringingLine(progress)}
          </p>
          <div
            className="bc-bar"
            role="progressbar"
            aria-label="Bringing chats"
            aria-valuemin={0}
            aria-valuemax={Math.max(progress.chatsTotal, 1)}
            aria-valuenow={progress.chatsDone}
          >
            <span className="bc-bar-fill" style={{ width: `${progress.chatsTotal > 0 ? Math.min(100, (progress.chatsDone / progress.chatsTotal) * 100) : 0}%` }} />
          </div>
          <div className="bc-actions">
            <button type="button" className="ck-btn ck-btn--secondary" onClick={() => void stop()}>
              Stop
            </button>
          </div>
        </>
      )}

      {view === 'done' && (
        <>
          <p className="ck-sub" role="status">
            {progress.phase === 'done' ? doneLine(progress) : progress.phase === 'cancelled' ? `Stopped. ${chatCount(progress.brought)} brought so far are kept.` : (progress.message ?? 'Could not bring the chats.')}
          </p>
          {progress.unchanged > 0 && progress.phase === 'done' && <p className="ck-sub">{`${chatCount(progress.unchanged)} were already in your chat list.`}</p>}
          {failed > 0 && (
            <details className="bc-why">
              <summary>Why?</summary>
              <ul>
                {why.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </details>
          )}
          {confirming ? (
            <>
              <p className="ck-sub">{BRING_REMOVE_BODY}</p>
              <div className="bc-actions">
                <button type="button" className="ck-btn ck-btn--secondary" onClick={() => setConfirming(false)}>
                  Cancel
                </button>
                <button type="button" className="ck-btn ck-btn--primary" disabled={busy} onClick={() => void remove()}>
                  Remove
                </button>
              </div>
            </>
          ) : (
            <div className="bc-actions">
              <button type="button" className="ck-btn ck-btn--plain" disabled={busy} onClick={() => setConfirming(true)}>
                Remove imported chats
              </button>
              <button
                type="button"
                className="ck-btn ck-btn--secondary"
                onClick={() => {
                  setResult(false);
                  if (agent) void loadRows(0);
                }}
              >
                Bring more
              </button>
              {onClose && (
                <button type="button" className="ck-btn ck-btn--primary" onClick={onClose}>
                  Done
                </button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
