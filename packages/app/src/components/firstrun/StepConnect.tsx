// Step 2: connect the agents. One button writes Potato Workspace into the agents' own config files, the
// same install Settings > Bridge & MCP > "Add Potato Workspace to your agents" runs (`agent_pack_*`; its
// plan, its Undo). The files that change are listed before the button is pressed.
import { useCallback, useEffect, useRef, useState } from 'react';
import { agentPackApi, groupAgents, visibleRows, type AgentPackApi, type PackReport, type PackRow } from '../../lib/agent-pack';
import { loadSettings } from '../../lib/settings';
import { errText } from '../../lib/toolbelt';
import { DotSpinner } from '../cockpit/DotSpinner';
import { t, useT } from '../../i18n';
import { T } from './copy';
import type { Connected } from './model';

/** The installed agents' rows of a plan. */
export function installedRows(report: PackReport): PackRow[] {
  return visibleRows(groupAgents(report.agents)).filter((r) => r.installed);
}

/** A row still has something to write (a connection to add or fix). */
const pending = (row: PackRow): boolean => row.mcp?.status === 'ready' || row.skills?.status === 'ready';

/** `yes` when at least one installed agent has the connection and none has more to add. */
export function connectedOf(report: PackReport): Connected {
  const rows = installedRows(report);
  if (rows.length === 0) return 'no';
  if (rows.some(pending)) return 'no';
  return rows.some((r) => r.mcp?.status === 'unchanged') ? 'yes' : 'no';
}

/**
 * What an update of the connection entry really changes, from the plan's changed lines: where it pointed
 * before (the removed line), or that only missing settings are added.
 */
export function updateSentence(diff: string): string {
  const lines = diff.split('\n');
  // Only the keys that say which program runs count: `command` and `args` (TOML `key = value`, JSON `"key": value`).
  const program = (l: string) => /^\s*"?(command|args)"?\s*[=:]/.test(l.slice(2));
  const strings = (l: string) => Array.from(l.slice(2).matchAll(/"([^"]*)"/g), (m) => m[1]).filter((x) => x !== 'command' && x !== 'args');
  const removed = lines.filter((l) => l.startsWith('- ') && program(l));
  const added = lines.filter((l) => l.startsWith('+ ') && program(l));
  // A different program replaced the old one: say where it pointed. Anything else only adds settings.
  if (removed.length === 0 || added.length === 0) return T.connectFixSettings;
  const old = removed.flatMap(strings).join(' ').trim();
  const next = added.flatMap(strings).join(' ').trim();
  return old && old !== next ? T.connectPointsTo(old) : T.connectFixSettings;
}

/** The config files a press of the button would change, in plain order. */
export function changingFiles(rows: PackRow[]): { key: string; agent: string; path: string; what: string }[] {
  return rows.flatMap((row) => {
    const out: { key: string; agent: string; path: string; what: string }[] = [];
    const agent = row.labels.join(', ');
    if (row.mcp?.status === 'ready') {
      out.push({ key: `${row.key}|mcp`, agent, path: row.mcp.path, what: row.mcp.change === 'update' ? updateSentence(row.mcp.diff) : T.connectFileAdd });
    }
    if (row.skills?.status === 'ready') {
      const n = row.skills.files.filter((f) => f.kind !== 'unchanged').length;
      out.push({ key: `${row.key}|skills`, agent, path: row.skills.path, what: t('firstRun.skills', { count: n }) });
    }
    return out;
  });
}

export function StepConnect({
  api = agentPackApi,
  connected,
  onConnected,
  dev = import.meta.env.DEV,
  load = loadSettings,
}: {
  api?: AgentPackApi;
  connected: Connected;
  onConnected: (connected: Connected) => void;
  /** A dev build (not installed): the entry would point at this copy. */
  dev?: boolean;
  /** Reads "Show developer settings": the file paths and the dev build note show only while it is on. */
  load?: typeof loadSettings;
}) {
  useT();
  const [developer, setDeveloper] = useState(false);
  const [report, setReport] = useState<PackReport | null>(null);
  const [busy, setBusy] = useState<'add' | 'undo' | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'problem'; text: string } | null>(null);
  const [restart, setRestart] = useState(false);
  const alive = useRef(true);
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;

  useEffect(() => {
    let live = true;
    void load()
      .then((s) => live && setDeveloper(s?.show_developer_settings === true))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [load]);

  const look = useCallback(async () => {
    try {
      const r = await api.preview();
      if (!alive.current) return null;
      setReport(r);
      onConnectedRef.current(connectedOf(r));
      return r;
    } catch (e) {
      if (alive.current) {
        setReport({ dry_run: true, agents: [], unsupported: [], recorded: 0 });
        setMessage({ tone: 'problem', text: `${T.connectFailed} ${errText(e)}` });
      }
      return null;
    }
  }, [api]);

  useEffect(() => {
    alive.current = true;
    void look();
    return () => {
      alive.current = false;
    };
  }, [look]);

  const rows = report ? installedRows(report) : [];
  const files = changingFiles(rows);
  const names = rows.filter(pending).flatMap((r) => r.labels);

  const add = async () => {
    setBusy('add');
    setMessage(null);
    try {
      await api.apply();
      setRestart(true);
      await look();
    } catch (e) {
      setMessage({ tone: 'problem', text: `${T.connectFailed} ${errText(e)}` });
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const undo = async () => {
    setBusy('undo');
    setMessage(null);
    try {
      await api.undo();
      setRestart(false);
      await look();
      if (alive.current) setMessage({ tone: 'ok', text: T.connectUndone });
    } catch (e) {
      setMessage({ tone: 'problem', text: `${T.connectFailed} ${errText(e)}` });
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  return (
    <section className="fr-step" aria-labelledby="fr-connect-t">
      <div className="ck-doto fr-num" aria-hidden="true">02</div>
      <h1 className="ck-title" id="fr-connect-t">{T.connectTitle}</h1>
      <p className="fr-lead">{T.connectLead}</p>

      {report === null && <p className="fr-hint" role="status">{T.connectLooking}</p>}

      {report !== null && rows.length === 0 && <p className="fr-hint" role="status">{T.connectNone}</p>}

      {connected === 'yes' && (
        <div className="fr-result" data-testid="connect-done">
          <div className="fr-result-head">
            <DotSpinner status="exited" size={3} />
            <h2 className="ck-section">{T.connectDone}</h2>
          </div>
          {restart && <p className="fr-hint">{T.connectDoneRestart}</p>}
        </div>
      )}

      {files.length > 0 && !developer && (
        <div className="fr-card" data-testid="connect-summary">
          <p className="fr-hint">{T.connectSummary(names)}</p>
          <p className="fr-hint">{T.connectBackups}</p>
        </div>
      )}
      {files.length > 0 && developer && (
        <div className="fr-card" data-testid="connect-files">
          <h2 className="fr-cap">{T.connectFilesTitle}</h2>
          <ul className="fr-files">
            {files.map((f) => (
              <li key={f.key}>
                <span className="fr-file-agent">{f.agent}</span>
                <span className="fr-mono fr-file-path" title={f.path}>{f.path}</span>
                <span className="fr-hint fr-file-what">{f.what}</span>
              </li>
            ))}
          </ul>
          {dev && (
            <p className="fr-hint" data-testid="connect-dev">
              {T.connectDevWarn}
            </p>
          )}
          <p className="fr-hint">{T.connectBackups}</p>
        </div>
      )}
      {report !== null && rows.length > 0 && files.length === 0 && connected === 'yes' && <p className="fr-hint">{T.connectFilesNone}</p>}

      {message && (
        <p className="fr-hint" role={message.tone === 'problem' ? 'alert' : 'status'} data-testid="connect-message">
          {message.text}
        </p>
      )}

      <div className="fr-actions">
        {names.length > 0 && (
          <button type="button" className="ck-btn ck-btn--primary" disabled={busy !== null} onClick={() => void add()}>
            {busy === 'add' ? T.connectAdding : T.connectButton(names)}
          </button>
        )}
        {report !== null && report.recorded > 0 && (
          <button type="button" className="ck-btn ck-btn--secondary" disabled={busy !== null} onClick={() => void undo()}>
            {busy === 'undo' ? T.connectUndoing : T.connectUndo}
          </button>
        )}
      </div>
    </section>
  );
}
