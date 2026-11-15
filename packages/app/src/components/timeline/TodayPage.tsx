// "Today": the whole-day time machine. One line for the day with a lane per project, a mark per finished
// turn, a detail card for the picked point, and one button to go back to it. The files come from the save
// points the app already takes at every turn; this page only reads them and, on request, puts one project back.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { errorSentence } from '../../lib/sayError';
import {
  dateOfMs,
  shiftDate,
  timelineApi,
  type GoBackReport,
  type PointRef,
  type TimelineApi,
  type TimelineDay,
} from '../../lib/timeline';
import { restoreWithUndo, type Notify, type RestoreWords } from '../cockpit/restore-flow';
import { defaultAgentName } from './agent-name';
import { DetailCard } from './DetailCard';
import { GoBackSheet } from './GoBackSheet';
import {
  agentTypes,
  buildLanes,
  clock,
  clusterWindow,
  dayWindow,
  hourWindow,
  markOrder,
  snapMark,
  type Filters,
  type Mark,
} from './lanes-model';
import { panesInFolder, refusalOf, type PaneLite } from './refusal';
import { TimelineLine } from './TimelineLine';
import { usePointDetail } from './use-point-detail';
import '../../styles/cockpit-timeline.css';

/** The newest mark that can still be gone back to, else the newest mark. */
export { defaultAgentName };

export function defaultMark(order: Mark[]): Mark | null {
  for (let i = order.length - 1; i >= 0; i--) if (!order[i].faded) return order[i];
  return order[order.length - 1] ?? null;
}

function pointOf(mark: Mark | null): PointRef | null {
  return mark ? { project: mark.row.project, key: mark.row.key, id: mark.row.id } : null;
}

function dayTitle(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

export function TodayPage({
  api = timelineApi,
  onClose,
  notify,
  panes = [],
  agentName = defaultAgentName,
  simple = false,
  now = Date.now,
  refreshMs = 60_000,
}: {
  api?: TimelineApi;
  onClose: () => void;
  notify: Notify;
  /** The live chats: a chat working in the folder stops a go back, and the others are named in the warning. */
  panes?: readonly PaneLite[];
  agentName?: (agentType: string) => string;
  /** Simple mode: no turn numbers or line counts, "went back" wording. */
  simple?: boolean;
  now?: () => number;
  refreshMs?: number;
}) {
  const t = useT();
  const [date, setDate] = useState(() => dateOfMs(now()));
  const [day, setDay] = useState<TimelineDay | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [filters, setFilters] = useState<Filters>({ project: 'all', agent: 'all', showHelpers: false });
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [dragMs, setDragMs] = useState<number | null>(null);
  const [zoom, setZoom] = useState<'day' | 'hour'>('day');
  // A busy stretch opened from its pill: its own window, until a zoom button or another day is picked.
  const [stretch, setStretch] = useState<{ startMs: number; endMs: number } | null>(null);
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [detailTick, setDetailTick] = useState(0);
  const alive = useRef(true);
  const afterSheet = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    api.day(date).then(
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
  }, [api, date, tick]);

  // Today keeps up with new turns.
  const isToday = day ? date === day.today : date === dateOfMs(now());
  useEffect(() => {
    if (!isToday || refreshMs <= 0) return;
    const id = window.setInterval(() => setTick((n) => n + 1), refreshMs);
    return () => window.clearInterval(id);
  }, [isToday, refreshMs]);

  const lanes = useMemo(() => (day ? buildLanes(day, filters) : []), [day, filters]);
  const order = useMemo(() => markOrder(lanes), [lanes]);
  const selected = order.find((m) => m.id === pickedId) ?? defaultMark(order);
  const point = pointOf(selected);
  const detail = usePointDetail(api, point, detailTick);
  const nowMs = day?.nowMs ?? now();
  const handleMs = dragMs ?? selected?.row.atMs ?? null;
  const windowMs = stretch ?? (zoom === 'hour' && handleMs !== null ? hourWindow(handleMs) : dayWindow(lanes, nowMs, isToday));
  const laneName = selected ? lanes[selected.lane]?.name ?? '' : '';
  const refusal = selected ? refusalOf(selected, panes, detail.backError) : null;
  const sharedWith = selected ? panesInFolder(panes, selected.row.project).map((p) => p.name) : [];

  const pick = useCallback((mark: Mark) => {
    setDragMs(null);
    setPickedId(mark.id);
  }, []);

  const goTo = (next: string) => {
    setDate(next);
    setDay(undefined);
    setPickedId(null);
    setDragMs(null);
    setZoom('day');
    setStretch(null);
  };

  const confirm = async () => {
    if (!selected || !point) return;
    const target = selected;
    setBusy(true);
    let calls = 0;
    // The first call goes back; a later one is the toast's Undo, which restores the safety copy kept in the `day` series.
    const adapter = {
      checkpointRestore: (_pane: string, id: string) => {
        const undoing = calls++ > 0;
        return api.goBack({ project: point.project, key: undoing ? 'day' : point.key, id }).then((report: GoBackReport) => {
          if (undoing && alive.current) setTick((n) => n + 1);
          return report;
        });
      },
    };
    const words: RestoreWords = {
      restored: (_target, report) =>
        (simple ? t('timeline.simple.wentBack', { time: clock(target.row.atMs) }) : t('timeline.wentBack', { time: clock(target.row.atMs), project: laneName })) +
        (report.failed.length ? t('timeline.failedFiles', { n: report.failed.length }) : ''),
      undo: t('timeline.undo'),
      undone: t('timeline.undone'),
    };
    const report = await restoreWithUndo(adapter, point.key, { id: point.id, label: laneName }, notify, words);
    if (!alive.current) return;
    afterSheet.current = true;
    setSheet(false);
    setBusy(false);
    if (report) {
      setTick((n) => n + 1);
      setDetailTick((n) => n + 1);
    }
  };

  // When the sheet closes, focus goes back to the mark (the sheet's own focus return would land on the button).
  useEffect(() => {
    if (sheet || !afterSheet.current || !selected) return;
    afterSheet.current = false;
    const el = [...document.querySelectorAll<HTMLElement>('.ck-tl-mark')].find((m) => m.dataset.markId === selected.id);
    el?.focus();
  }, [sheet, selected]);

  // One choice for each lane as drawn: a worktree is part of its parent's.
  const projects = useMemo(() => (day ? buildLanes(day, { project: 'all', agent: 'all', showHelpers: filters.showHelpers }) : []), [day, filters.showHelpers]);
  const agents = day ? agentTypes(day) : [];
  const canGoEarlier = !day || day.dates.length === 0 || day.dates.some((d) => d < date);
  const nothing = day && order.length === 0;

  return (
    <div className="ck-tl-page" data-testid="timeline-page" data-simple={simple ? 'true' : undefined}>
      <header className="ck-memory-head">
        <div>
          <h1 className="ck-title">{simple ? t('timeline.simple.title') : isToday ? t('timeline.title') : dayTitle(date)}</h1>
          <p className="ck-sub">{simple ? t('timeline.simple.sub') : isToday ? `${dayTitle(date)}. ${t('timeline.sub')}` : t('timeline.olderNote')}</p>
        </div>
        <button type="button" className="ck-btn ck-btn--plain" onClick={onClose}>
          {t('timeline.close')}
        </button>
      </header>

      <div className="ck-tl-controls">
        <div className="ck-tl-seg" role="group" aria-label={dayTitle(date)}>
          <button type="button" className="ck-tl-seg-btn" disabled={!canGoEarlier} onClick={() => goTo(shiftDate(date, -1))}>
            ‹ {t('timeline.earlier')}
          </button>
          <button type="button" className="ck-tl-seg-btn" disabled={isToday} onClick={() => goTo(shiftDate(date, 1))}>
            {t('timeline.later')} ›
          </button>
        </div>
        {projects.length > 1 && (
          <select className="ck-tl-select" aria-label={t('timeline.projects')} value={filters.project} onChange={(e) => setFilters({ ...filters, project: e.target.value })}>
            <option value="all">{t('timeline.allProjects')}</option>
            {projects.map((p) => (
              <option key={p.project} value={p.project}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        {agents.length > 1 && !simple && (
          <select className="ck-tl-select" aria-label={t('timeline.agents')} value={filters.agent} onChange={(e) => setFilters({ ...filters, agent: e.target.value })}>
            <option value="all">{t('timeline.allAgents')}</option>
            {agents.map((a) => (
              <option key={a} value={a}>
                {agentName(a)}
              </option>
            ))}
          </select>
        )}
        {!simple && (
          <label className="ck-tl-check">
            <input type="checkbox" checked={filters.showHelpers} onChange={(e) => setFilters({ ...filters, showHelpers: e.target.checked })} />
            {t('timeline.helpers')}
          </label>
        )}
        <div className="ck-tl-seg" role="group" aria-label={t('timeline.zoom')}>
          <button type="button" className="ck-tl-seg-btn" aria-pressed={zoom === 'day'} onClick={() => { setStretch(null); setZoom('day'); }}>
            {t('timeline.zoomDay')}
          </button>
          <button type="button" className="ck-tl-seg-btn" aria-pressed={zoom === 'hour'} disabled={handleMs === null} onClick={() => { setStretch(null); setZoom('hour'); }}>
            {t('timeline.zoomHour')}
          </button>
        </div>
      </div>

      {error && (
        <p className="ck-tl-error" role="alert">
          {t('timeline.error', { error })}{' '}
          <button type="button" className="ck-btn ck-btn--plain" onClick={() => setTick((n) => n + 1)}>
            {t('timeline.retry')}
          </button>
        </p>
      )}
      {day === undefined && !error && <p className="ck-sub">{t('timeline.loading')}</p>}
      {nothing && (
        <p className="ck-sub ck-tl-empty" data-testid="timeline-empty">
          {filters.project !== 'all' || filters.agent !== 'all' ? t('timeline.emptyFiltered') : isToday ? t('timeline.emptyToday') : t('timeline.emptyDay')}
        </p>
      )}
      {order.length > 0 && (
        <>
          <TimelineLine
            lanes={lanes}
            windowMs={windowMs}
            nowMs={nowMs}
            showNow={isToday}
            selectedId={selected?.id ?? null}
            handleMs={handleMs}
            agentName={agentName}
            simple={simple}
            onSelect={pick}
            onHandle={(ms, laneIndex) => {
              setDragMs(ms);
              const mark = snapMark(lanes[laneIndex]?.marks ?? [], ms);
              if (mark) setPickedId(mark.id);
            }}
            onHandleEnd={() => setDragMs(null)}
            onWheelZoom={(dir) => {
              setStretch(null);
              setZoom(dir === 'in' && handleMs !== null ? 'hour' : 'day');
            }}
            onOpenCluster={(marks, focus) => {
              pick(focus ?? marks[0]);
              setStretch(clusterWindow(marks));
            }}
          />
          {selected && point && (
            <DetailCard
              mark={selected}
              laneName={laneName}
              point={point}
              detail={detail}
              api={api}
              agentName={agentName(selected.row.agentType)}
              simple={simple}
              refusal={refusal}
              busy={busy}
              onGoBack={() => setSheet(true)}
            />
          )}
          <p className="ck-sub ck-tl-legend">{t('timeline.legend')}</p>
        </>
      )}
      <p className="ck-sub ck-tl-limits">{t('timeline.limits')}</p>

      {sheet && selected && (
        <GoBackSheet
          time={clock(selected.row.atMs)}
          project={laneName}
          back={detail.back}
          sharedWith={sharedWith}
          simple={simple}
          busy={busy}
          onCancel={() => {
            afterSheet.current = true;
            setSheet(false);
          }}
          onConfirm={() => void confirm()}
        />
      )}
    </div>
  );
}
