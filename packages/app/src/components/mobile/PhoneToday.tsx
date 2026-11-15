// "Today" on the phone: the day as one short strip (every project squeezed into one line of ticks) with a handle,
// and under it a list by time, newest first, grouped by hour. The list is the main way to pick a point; the strip
// is for finding your way. A tap on a row opens a sheet with the two counts and the file names (patches open one
// file at a time, read only). "Go back to here" is allowed behind two steps: a sheet with the project, the time and
// the counts, and then a press and hold. After it a "Went back to ..." row sits at the top with Undo.
import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { useT } from '../../i18n';
import { errorSentence } from '../../lib/sayError';
import { dateOfMs, type GoBackReport, type NowDiff, type PointFile, type PointRef, type TimelineApi, type TimelineDay } from '../../lib/timeline';
import { AgentLogo } from '../common/AgentLogo';
import { lineKind } from '../cockpit/diff';
import { backSummary } from '../timeline/back-summary';
import { buildAxis, buildLanes, clock, dayWindow, markOrder, snapMark, type Mark } from '../timeline/lanes-model';
import { refusalFromMessage, refusalOf, type PaneLite } from '../timeline/refusal';
import { defaultAgentName } from '../timeline/agent-name';
import { HoldButton } from './HoldButton';
import { Sheet } from './MobileSheet';
import '../../styles/ph-timeline.css';

const STRIP_FALLBACK_PX = 320;

interface Went {
  time: string;
  project: string;
  /** The safety copy to bring back with Undo, when the PC made one. */
  undo: PointRef | null;
  undone: boolean;
}

function PatchLines({ patch }: { patch: string }) {
  // One file's patch: drop the header lines, keep the hunks.
  const lines = patch.split('\n').filter((l) => !/^(diff --git|index |--- |\+\+\+ )/.test(l));
  return (
    <pre className="ph-tl-patch" aria-label="patch">
      {lines.map((line, i) => (
        <span key={i} className={`ph-tl-line ph-tl-line--${lineKind(line)}`}>
          {line}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

export function PhoneToday({
  api,
  panes = [],
  onClose,
  agentName = defaultAgentName,
  now = Date.now,
}: {
  api: TimelineApi;
  panes?: readonly PaneLite[];
  onClose: () => void;
  agentName?: (agentType: string) => string;
  now?: () => number;
}) {
  const t = useT();
  const [day, setDay] = useState<TimelineDay | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [project, setProject] = useState('all');
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [open, setOpen] = useState<Mark | null>(null);
  const [went, setWent] = useState<Went | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const [stripPx, setStripPx] = useState(STRIP_FALLBACK_PX);
  const dragging = useRef(false);

  useEffect(() => {
    let live = true;
    api.day(dateOfMs(now())).then(
      (next) => {
        if (!live) return;
        setDay(next);
        setError(null);
      },
      (e) => {
        if (!live) return;
        setError(errorSentence(e));
        setDay((cur) => cur ?? null);
      },
    );
    return () => {
      live = false;
    };
  }, [api, tick, now]);

  useEffect(() => {
    const el = stripRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const w = Math.round(el.getBoundingClientRect().width);
      if (w > 40) setStripPx(w);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [day]);

  const lanes = useMemo(() => (day ? buildLanes(day, { project, agent: 'all', showHelpers: false }) : []), [day, project]);
  const order = useMemo(() => markOrder(lanes), [lanes]);
  const selected = order.find((m) => m.id === pickedId) ?? order[order.length - 1] ?? null;
  const win = dayWindow(lanes, day?.nowMs ?? now(), true);
  const axis = useMemo(() => buildAxis(order.map((m) => m.row.atMs), win.startMs, win.endMs, stripPx), [order, win.startMs, win.endMs, stripPx]);
  const newestFirst = [...order].reverse();

  // The list is grouped by hour, newest first.
  const groups: { hour: number; marks: Mark[] }[] = [];
  for (const m of newestFirst) {
    const hour = new Date(m.row.atMs).getHours();
    const last = groups[groups.length - 1];
    if (last && last.hour === hour) last.marks.push(m);
    else groups.push({ hour, marks: [m] });
  }

  const pointer = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const mark = snapMark(order, axis.msAt(event.clientX - rect.left));
    if (mark) setPickedId(mark.id);
  };

  const names = (project: string) => lanes.find((l) => l.project === project)?.name ?? project;
  // One chip for each lane as drawn: a worktree is part of its parent's.
  const projects = useMemo(() => (day ? buildLanes(day, { project: 'all', agent: 'all', showHelpers: false }) : []), [day]);

  return (
    <Sheet title={t('timeline.phone.title')} onClose={onClose}>
      <div className="ph-tl" data-testid="phone-today">
        {error && (
          <p className="ph-foot ph-foot--err" role="alert">
            {error}
          </p>
        )}
        {day === undefined && !error && <p className="ph-foot">{t('timeline.loading')}</p>}
        {day && order.length === 0 && <p className="ph-tl-empty">{t('timeline.phone.empty')}</p>}

        {went && (
          <div className="ph-tl-went" role="status" data-testid="phone-went">
            <span>{went.undone ? t('timeline.undone') : t('timeline.phone.wentBack', { time: went.time })}</span>
            {went.undo && !went.undone && (
              <button
                type="button"
                className="ph-tl-undo"
                onClick={() => {
                  const target = went.undo!;
                  api.goBack(target).then(
                    () => {
                      setWent({ ...went, undone: true });
                      setTick((n) => n + 1);
                    },
                    (e) => setError(errorSentence(e)),
                  );
                }}
              >
                {t('timeline.undo')}
              </button>
            )}
          </div>
        )}

        {order.length > 0 && (
          <>
            {projects.length > 1 && (
              <div className="ph-tl-chips" role="group" aria-label={t('timeline.projects')}>
                <button type="button" className="ph-tl-chip" aria-pressed={project === 'all'} onClick={() => setProject('all')}>
                  {t('timeline.phone.allProjects')}
                </button>
                {projects.map((p) => (
                  <button key={p.project} type="button" className="ph-tl-chip" aria-pressed={project === p.project} onClick={() => setProject(p.project)}>
                    {p.name}
                  </button>
                ))}
              </div>
            )}

            <div
              className="ph-tl-strip"
              ref={stripRef}
              role="group"
              aria-label={t('timeline.phone.strip')}
              onPointerDown={(e) => {
                dragging.current = true;
                e.currentTarget.setPointerCapture?.(e.pointerId);
                pointer(e);
              }}
              onPointerMove={(e) => dragging.current && pointer(e)}
              onPointerUp={() => (dragging.current = false)}
            >
              {order.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className="ph-tl-tick"
                  data-selected={m.id === selected?.id ? 'true' : undefined}
                  data-faded={m.faded ? 'true' : undefined}
                  style={{ left: axis.xOf(m.row.atMs) }}
                  aria-label={`${clock(m.row.atMs)}, ${names(m.row.project)}`}
                  tabIndex={-1}
                  onClick={() => setPickedId(m.id)}
                />
              ))}
              {selected && <span className="ph-tl-handle" style={{ left: axis.xOf(selected.row.atMs) }} aria-hidden="true" />}
            </div>

            <div className="ph-tl-list">
              {groups.map((g) => (
                <section key={g.hour} className="ph-tl-hour" aria-label={t('timeline.phone.hourLine', { hour: String(g.hour).padStart(2, '0') })}>
                  <h3 className="ph-tl-hourh">{t('timeline.phone.hourLine', { hour: String(g.hour).padStart(2, '0') })}</h3>
                  <ul>
                    {g.marks.map((m) => (
                      <li key={m.id}>
                        <button
                          type="button"
                          className="ph-tl-row"
                          aria-current={m.id === selected?.id ? 'true' : undefined}
                          data-faded={m.faded ? 'true' : undefined}
                          onClick={() => {
                            setPickedId(m.id);
                            setOpen(m);
                          }}
                        >
                          <span className="ph-tl-time">{clock(m.row.atMs)}</span>
                          {m.shape === 'undo' ? <span className="ph-tl-back" aria-hidden="true">↩</span> : <AgentLogo id={m.row.agentType} name={agentName(m.row.agentType)} size={14} decorative />}
                          <span className="ph-tl-text">
                            <span className="ph-tl-project">{names(m.row.project)}</span>
                            <span className="ph-tl-note">{m.shape === 'undo' ? t('timeline.mark.wentBack') : m.row.note || m.row.chatTitle || agentName(m.row.agentType)}</span>
                          </span>
                          <span className="ph-tl-files">
                            {t(m.row.files === 1 ? 'timeline.mark.file' : 'timeline.mark.files', { n: m.row.files })}
                            <span className="ph-tl-delta">
                              +{m.row.added} −{m.row.deleted}
                            </span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </>
        )}
        <p className="ph-tl-limits">{t('timeline.limits')}</p>
      </div>

      {open && (
        <PointSheet
          mark={open}
          laneName={names(open.row.project)}
          api={api}
          panes={panes}
          onClose={() => setOpen(null)}
          onWent={(report, mark) => {
            setOpen(null);
            setWent({
              time: clock(mark.row.atMs),
              project: names(mark.row.project),
              undo: report.safetyId ? { project: mark.row.project, key: 'day', id: report.safetyId } : null,
              undone: false,
            });
            setTick((n) => n + 1);
          }}
        />
      )}
    </Sheet>
  );
}

/** One point: the two counts and the file names, then the two-step go back. */
function PointSheet({
  mark,
  laneName,
  api,
  panes,
  onClose,
  onWent,
}: {
  mark: Mark;
  laneName: string;
  api: TimelineApi;
  panes: readonly PaneLite[];
  onClose: () => void;
  onWent: (report: GoBackReport, mark: Mark) => void;
}) {
  const t = useT();
  const point: PointRef = { project: mark.row.project, key: mark.row.key, id: mark.row.id };
  const [turn, setTurn] = useState<PointFile[] | string | undefined>(undefined);
  const [back, setBack] = useState<NowDiff | undefined>(undefined);
  const [backError, setBackError] = useState<string | null>(null);
  const [step, setStep] = useState<'look' | 'confirm'>('look');
  const [opened, setOpened] = useState<{ path: string; text: string | null } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api.pointDiff(point).then(
      (files) => live && setTurn(files),
      (e) => live && setTurn(errorSentence(e)),
    );
    api.nowDiff(point).then(
      (next) => live && setBack(next),
      (e) => live && setBackError(errorSentence(e)),
    );
    return () => {
      live = false;
    };
    // The point is fixed for this sheet's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, mark.id]);

  const refusal = refusalOf(mark, panes, backError);
  const files = Array.isArray(turn) ? turn : [];

  const show = (path: string, side: 'turn' | 'now') => {
    if (opened?.path === `${side}:${path}`) return setOpened(null);
    setOpened({ path: `${side}:${path}`, text: null });
    api.filePatch(point, path, side).then(
      (p) => setOpened((cur) => (cur?.path === `${side}:${path}` ? { path: cur.path, text: p.patch } : cur)),
      (e) => setOpened({ path: `${side}:${path}`, text: errorSentence(e) }),
    );
  };

  const go = () => {
    setBusy(true);
    api.goBack(point).then(
      (report) => onWent(report, mark),
      (e) => {
        setBusy(false);
        setFailed(errorSentence(e));
        setStep('look');
        if (refusalFromMessage(errorSentence(e)) !== 'other') setBackError(errorSentence(e));
      },
    );
  };

  const fileList = (list: PointFile[], side: 'turn' | 'now') => (
    <ul className="ph-tl-filelist">
      {list.map((f) => (
        <li key={`${side}${f.path}`}>
          <button type="button" className="ph-tl-file" aria-expanded={opened?.path === `${side}:${f.path}`} onClick={() => show(f.path, side)}>
            <span className="ph-tl-fstatus">{f.status}</span>
            <span className="ph-tl-fpath">{f.path}</span>
          </button>
          {opened?.path === `${side}:${f.path}` && (opened.text === null ? <p className="ph-foot">{t('timeline.detail.patchLoading')}</p> : opened.text === '' ? <p className="ph-foot">{t('timeline.detail.patchEmpty')}</p> : <PatchLines patch={opened.text} />)}
        </li>
      ))}
    </ul>
  );

  return (
    <Sheet title={`${clock(mark.row.atMs)} · ${laneName}`} onClose={onClose}>
      <div className="ph-tl-sheet" data-testid="phone-point">
        {step === 'look' ? (
          <>
            <p className="ph-tl-count" data-testid="phone-turn-count">
              {turn === undefined ? t('timeline.detail.loading') : typeof turn === 'string' ? turn : t('timeline.phone.turn', { n: files.length })}
            </p>
            <p className="ph-tl-count" data-testid="phone-back-count">
              {back ? `${t('timeline.phone.change', { n: back.total })}${back.removed > 0 ? `, ${t('timeline.phone.removed', { n: back.removed })}` : ''}` : backError ? '' : t('timeline.detail.loading')}
            </p>
            {files.length > 0 && fileList(files, 'turn')}
            {back && back.files.length > 0 && (
              <>
                <h3 className="ph-tl-h">{t('timeline.detail.backTitle')}</h3>
                {fileList(back.files, 'now')}
                {back.more > 0 && <p className="ph-foot">{t('timeline.detail.more', { n: back.more })}</p>}
              </>
            )}
            {failed && (
              <p className="ph-foot ph-foot--err" role="alert">
                {failed}
              </p>
            )}
            {refusal && (
              <p className="ph-tl-why" role="status">
                {t(`timeline.refuse.${refusal}` as const)}
              </p>
            )}
            <button type="button" className="ph-tl-go" disabled={refusal !== null || back === undefined} onClick={() => setStep('confirm')}>
              {t('timeline.goBack')}
            </button>
          </>
        ) : (
          <>
            <h3 className="ph-tl-h">{t('timeline.sheet.title', { time: clock(mark.row.atMs), project: laneName })}</h3>
            {back && <p className="ph-tl-count">{backSummary(back, t)}</p>}
            <p className="ph-foot">{t('timeline.sheet.body')}</p>
            <p className="ph-foot">{t('timeline.sheet.safe')}</p>
            {back?.hasGit && <p className="ph-foot">{t('timeline.sheet.git')}</p>}
            <HoldButton label={busy ? t('timeline.sheet.busy') : t('timeline.sheet.hold')} disabled={busy} onDone={go} className="ph-tl-hold" />
            <button type="button" className="ph-tl-cancel" disabled={busy} onClick={() => setStep('look')}>
              {t('timeline.sheet.cancel')}
            </button>
          </>
        )}
      </div>
    </Sheet>
  );
}
