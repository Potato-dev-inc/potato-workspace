// "Follow a task": pick a task the lead was given and its path lights up on the canvas, box by box. Each step shows the exact words
// that were handed over and what came back. "Replay" walks the path again, one box at a time; a step can also be tapped.
// It reads the hand-overs the app made (who started which helper, with which task). It cannot show what an agent only thought,
// and nothing here sends or runs anything. Long words are cut, with "Show all".
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { crewErrorText, type Crew, type CrewFollowTask, type CrewsApi } from '../../lib/crews-api';
import { findRole, keyOf } from './model';

/** What the canvas lights: the boxes passed so far, the box it is at, and the hand-over lines used. */
export interface Trace {
  path: string[];
  now: string | null;
  hops: string[];
}
export const NO_TRACE: Trace = { path: [], now: null, hops: [] };

const CUT = 160;
const STEP_STATUS = ['queued', 'starting', 'running', 'waiting_input', 'cancelling', 'completed', 'failed', 'cancelled'];
const STEP_MS = 900;

/** The trace of the first `shown` steps of a task, with role names turned into the crew's role ids. */
export function traceOf(crew: Crew, task: CrewFollowTask, shown: number): Trace {
  const id = (name: string) => {
    const role = findRole(crew, name);
    return role ? keyOf(role) : null;
  };
  const path: string[] = [];
  const hops: string[] = [];
  let now: string | null = null;
  for (const step of task.steps.slice(0, shown)) {
    const to = id(step.role);
    const from = step.from ? id(step.from) : null;
    if (from && !path.includes(from)) path.push(from);
    if (to && !path.includes(to)) path.push(to);
    if (from && to) hops.push(`${from}>${to}`);
    if (to) now = to;
  }
  return { path, now, hops };
}

function Words({ text, label }: { text: string; label: string }) {
  const t = useT();
  const [all, setAll] = useState(false);
  const long = text.length > CUT;
  return (
    <span className="crewc-follow-words">
      <span className="crewc-follow-label">{label}</span> {all || !long ? text : `${text.slice(0, CUT)}…`}
      {long ? (
        <>
          {' '}
          <button type="button" className="crewc-link" aria-expanded={all} onClick={() => setAll((v) => !v)}>
            {all ? t('crewcanvas.follow.less') : t('crewcanvas.follow.all')}
          </button>
        </>
      ) : null}
    </span>
  );
}

export function Follow({ crew, api, onTrace }: { crew: Crew; api: Pick<CrewsApi, 'follow'>; onTrace: (trace: Trace) => void }) {
  const t = useT();
  const [tasks, setTasks] = useState<CrewFollowTask[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [shown, setShown] = useState(0);
  const [playing, setPlaying] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(() => {
    setError(null);
    api
      .follow(crew)
      .then((found) => setTasks(found))
      .catch((err) => {
        setTasks([]);
        setError(crewErrorText(err) || t('crewcanvas.follow.failed'));
      });
  }, [api, crew, t]);
  useEffect(load, [load]);

  const task = useMemo(() => tasks?.find((x) => x.id === picked) ?? null, [tasks, picked]);

  const stop = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    setPlaying(false);
  }, []);
  useEffect(() => stop, [stop]);

  // The canvas follows what is shown; leaving the tab clears it.
  useEffect(() => {
    onTrace(task ? traceOf(crew, task, shown) : NO_TRACE);
  }, [crew, task, shown, onTrace]);
  useEffect(() => () => onTrace(NO_TRACE), [onTrace]);

  const pick = (id: string) => {
    stop();
    const next = tasks?.find((x) => x.id === id);
    setPicked(id);
    setShown(next ? next.steps.length : 0);
  };

  const replay = () => {
    if (!task) return;
    stop();
    setShown(0);
    setPlaying(true);
    let n = 0;
    timer.current = setInterval(() => {
      n += 1;
      setShown(n);
      if (n >= task.steps.length) stop();
    }, STEP_MS);
  };

  const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const brief = (x: CrewFollowTask) => (x.words ? (x.words.length > 70 ? `${x.words.slice(0, 70)}…` : x.words) : t('crewcanvas.follow.noWords'));

  return (
    <div className="crewc-follow" data-testid="follow-task">
      <p className="crewc-hint">{t('crewcanvas.follow.note')}</p>
      {error ? (
        <p className="crewc-error" role="alert">
          {error}
        </p>
      ) : null}
      {tasks === null ? <p className="crewc-hint">{t('crewcanvas.follow.loading')}</p> : null}
      {tasks && tasks.length === 0 && !error ? <p className="crewc-hint">{t('crewcanvas.follow.none')}</p> : null}
      {tasks && tasks.length > 0 ? (
        <ul className="crewc-follow-tasks" aria-label={t('crewcanvas.follow.tasks')}>
          {tasks.map((x) => (
            <li key={x.id}>
              <button type="button" className={`crewc-follow-task${picked === x.id ? ' is-on' : ''}`} aria-pressed={picked === x.id} onClick={() => pick(x.id)}>
                <span className="crewc-follow-check" aria-hidden="true">
                  {picked === x.id ? '✓' : ''}
                </span>
                <span className="crewc-follow-brief">{brief(x)}</span>
                <span className="crewc-follow-meta">
                  {t(`crewcanvas.follow.status.${x.status}` as never)} · {time(x.at_ms)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <button type="button" className="crewc-btn crewc-btn--small" onClick={load}>
        {t('crewcanvas.follow.refresh')}
      </button>
      {task ? (
        <div className="crewc-way">
          <div className="crewc-follow-bar">
            <h4>{t('crewcanvas.follow.steps')}</h4>
            <button type="button" className="crewc-btn crewc-btn--small" disabled={playing || task.steps.length === 0} onClick={replay}>
              {playing ? t('crewcanvas.follow.playing') : t('crewcanvas.follow.replay')}
            </button>
          </div>
          <ol className="crewc-follow-steps" data-testid="follow-steps">
            {task.steps.map((s, i) => (
              <li key={`${s.role}-${s.at_ms}-${i}`} className={i < shown ? 'is-lit' : ''} data-lit={i < shown ? 'true' : 'false'}>
                <button type="button" className="crewc-follow-step" onClick={() => { stop(); setShown(i + 1); }}>
                  <span className="crewc-follow-who">{s.from ? t('crewcanvas.follow.handed', { from: s.from, to: s.role }) : t('crewcanvas.follow.gotTask', { to: s.role })}</span>
                </button>
                <Words text={s.words || '—'} label={t('crewcanvas.follow.words')} />
                {s.came_back ? <Words text={s.came_back} label={t('crewcanvas.follow.back')} /> : null}
                <span className="crewc-follow-meta">
                  {STEP_STATUS.includes(s.status) ? t(`crewcanvas.follow.stepStatus.${s.status}` as never) : s.status} · {time(s.at_ms)}
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}
