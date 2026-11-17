// One command an agent ran, as a dock pane: its name, how long it has run, the ports it listens on, a fold with the full
// command, the output (read only) and a way to stop it. A terminal the app hosts for the agent (`start_terminal`) has its
// output kept (the last 200 lines, masked); any other command only says so. A finished command shows how it ended.
import { useEffect, useRef, useState } from 'react';
import { useT } from '../../../i18n';
import { canStop, runTime, tauriJobsApi, usePaneJobs, type JobsApi } from '../../../lib/pane-jobs';
import type { TerminalRef } from '../../../lib/task-view';
import { StopSquare } from './BackgroundSection';

/** How often a running terminal's output is read again. */
export const OUTPUT_POLL_MS = 1500;
/** The most lines the view keeps. */
const KEEP = 500;

export function TerminalPane({
  term,
  onStop,
  api = tauriJobsApi,
}: {
  term: TerminalRef;
  onStop: (owner: string, pid: number, startedAtMs: number, terminalId?: string) => Promise<void>;
  api?: JobsApi;
}) {
  const t = useT();
  const jobs = usePaneJobs();
  const [now, setNow] = useState(() => Date.now());
  const [lines, setLines] = useState<string[]>([]);
  const [partial, setPartial] = useState<string | undefined>();
  const [ended, setEnded] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const cursor = useRef<number | undefined>(undefined);
  const box = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const job = (jobs[term.owner] ?? []).find((j) => (term.terminalId ? j.terminalId === term.terminalId : j.pid === term.pid && j.startedAtMs === term.startedAtMs));
  const ports = job?.ports ?? [];
  const live = !term.finished && !!job;

  // Read the output: all of it once, then what is new, while the command runs (once more when it has ended).
  useEffect(() => {
    const id = term.terminalId;
    if (!id || !api.output) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const got = await api.output!(id, cursor.current);
        if (stopped) return;
        setFailed(false);
        setLines((was) => (cursor.current === undefined ? got.lines : [...was, ...got.lines]).slice(-KEEP));
        cursor.current = got.nextCursor;
        setPartial(got.partialLine);
        setEnded(got.state === 'running' ? null : got.state);
        if (got.state === 'running') timer = setTimeout(() => void read(), OUTPUT_POLL_MS);
      } catch {
        if (!stopped) setFailed(true);
      }
    };
    cursor.current = undefined;
    setLines([]);
    setPartial(undefined);
    setEnded(null);
    void read();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [term.terminalId, api]);

  // Keep the view at the bottom while new lines arrive, unless the person scrolled up.
  useEffect(() => {
    const el = box.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 60) el.scrollTop = el.scrollHeight;
  }, [lines, partial]);

  const how = term.finished?.state ?? (ended === 'stopped' ? 'stopped' : ended ? 'done' : null);
  const stateWord = live ? t('dock.running') : how === 'failed' ? t('task.failed') : how === 'stopped' ? t('task.stopped') : t('dock.ended');
  return (
    <div className="tk-view tk-term" data-testid="dock-terminal" data-live={live ? 'true' : 'false'}>
      <div className="tk-meta">
        <p className="tk-line">
          <span className="tk-k">{stateWord}</span>
          {job && live && <span className="tk-time"> {runTime(job.startedAtMs, now)}</span>}
          {term.finished && <span className="tk-time"> {t('rail.bg.doneIn', { time: runTime(term.startedAtMs, term.finished.endedAtMs) })}</span>}
          {ports.map((p) => (
            <span key={p} className="tk-mono">
              {' '}
              {t('dock.port', { port: p })}
            </span>
          ))}
        </p>
        <details className="tk-fold-cmd">
          <summary>{t('dock.showCommand')}</summary>
          <pre className="tk-mono tk-cmd">{term.command}</pre>
        </details>
      </div>
      {term.terminalId ? (
        <pre ref={box} className="tk-mono tk-out" tabIndex={0} aria-label={t('dock.output')} data-testid="dock-output">
          {lines.length === 0 && !partial ? <span className="tk-quiet">{failed ? t('dock.outputGone') : t('dock.noOutput')}</span> : null}
          {[...lines, ...(partial ? [partial] : [])].join('\n')}
        </pre>
      ) : (
        <p className="tk-quiet tk-term-out">{t('dock.outputNotKept')}</p>
      )}
      {live && job && canStop(job) && (
        <footer className="tk-foot">
          <div className="tk-foot-row">
            <span className="tk-note" />
            <StopSquare name={term.name} onStop={() => onStop(term.owner, term.pid, term.startedAtMs, term.terminalId)} />
          </div>
        </footer>
      )}
    </div>
  );
}
