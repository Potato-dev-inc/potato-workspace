// The live view of a running workflow, in a column's width (Labs "Workflows"): the front agent on top, the agents it started in
// a wrapping row under it, one line between them that a dot travels on each start and each report, and the short log. It reads
// the model of `lib/workflow-model` (the same live data as the crew canvas's Live tab), so both tell the same story. It lives in the
// chat's details column (a pane) and, when that column is hidden, in a card at the top of the chat.
import { useT } from '../../i18n';
import { frontOf, keyOf } from './model';
import { formatElapsed } from '../cockpit/model';
import { eventText, liveWord, useNow } from '../../lib/workflow-live';
import { workflowCounts, type WorkflowModel } from '../../lib/workflow-model';
import { LiveStrip } from './LiveStrip';
import '../../styles/crew-canvas.css';
import '../../styles/workflow-dock.css';

interface Item {
  key: string;
  name: string;
  state: 'working' | 'done' | 'needs-you' | 'failed' | null;
  startedAt: number;
  endedAt?: number;
  count: number;
  helperId: string | null;
}

/** One box per agent the crew has (a box nobody stands in is quiet); without the saved crew, one box per agent that started. */
function itemsOf(m: WorkflowModel): Item[] {
  if (m.crew) {
    const out = m.crew.roles
      .filter((r) => !r.front)
      .map((r): Item => {
        const rl = m.roles.get(keyOf(r));
        return { key: keyOf(r), name: r.name, state: rl?.state ?? null, startedAt: rl?.startedAt ?? 0, endedAt: rl?.endedAt, count: rl?.count ?? 0, helperId: rl?.helperId ?? null };
      });
    // An agent no box of the crew fits still shows (it is real work).
    for (const h of m.helpers) if (!h.roleKey) out.push({ key: h.id, name: h.who, state: h.state, startedAt: h.startedAt, endedAt: m.feed.endedAt.get(h.id), count: 1, helperId: h.id });
    return out;
  }
  return m.helpers.map((h): Item => ({ key: h.id, name: h.who, state: h.state, startedAt: h.startedAt, endedAt: m.feed.endedAt.get(h.id), count: 1, helperId: h.id }));
}

export function WorkflowLive({ model, onOpenHelper, onOpenBig, showSummary = true }: { model: WorkflowModel; onOpenHelper: (helperId: string) => void; onOpenBig?: () => void; showSummary?: boolean }) {
  const t = useT();
  const items = itemsOf(model);
  const busy = model.helpers.some((h) => h.state === 'working' || h.state === 'needs-you') || model.frontWorking;
  const now = useNow(busy);
  const frontName = (model.crew && frontOf(model.crew)?.name) || t('wfdock.front');
  const pulsing = model.feed.pulse.size > 0;
  return (
    <div className="wfl" data-testid="wf-live" aria-label={t('wfdock.pane')}>
      {showSummary && workflowCounts(model.helpers, t) ? (
        <p className="wfl-summary" data-testid="wf-summary">
          {workflowCounts(model.helpers, t)}
        </p>
      ) : null}
      <div className={`wfl-front${model.frontWorking ? ' is-working' : ''}`} data-testid="wf-front" data-state={model.frontWorking ? 'working' : 'idle'}>
        <span className="wfl-name" title={frontName}>
          {frontName}
        </span>
        {model.frontWorking ? (
          <span className="crewc-live-state" data-state="working">
            {liveWord('working', t)}
          </span>
        ) : null}
      </div>
      <div className="wfl-flow" aria-hidden="true">
        <span className={`wfl-line${pulsing ? ' is-pulse' : ''}`} />
        {model.feed.dots.map((d) => (
          <span key={d.key} className="wfl-dot" data-testid="wf-dot" data-dir={d.dir} />
        ))}
      </div>
      {items.length === 0 ? (
        <p className="crewc-hint wfl-empty">{t('wfdock.waiting')}</p>
      ) : (
        <ul className="wfl-boxes" aria-label={t('wfdock.helpers')}>
          {items.map((it) => {
            const took = it.state === 'working' || it.state === 'needs-you' ? now - it.startedAt : it.endedAt !== undefined ? it.endedAt - it.startedAt : null;
            return (
              <li key={it.key} className="wfl-cell">
                <button
                  type="button"
                  className={`wfl-box${it.state ? ` has-${it.state}` : ''}`}
                  data-testid="wf-box"
                  data-state={it.state ?? 'idle'}
                  disabled={!it.helperId}
                  title={it.name}
                  onClick={() => it.helperId && onOpenHelper(it.helperId)}
                >
                  <span className="wfl-name">{it.name}</span>
                  {it.state ? (
                    <span className="crewc-live-line">
                      <span className="crewc-live-state" data-state={it.state}>
                        {liveWord(it.state, t)}
                      </span>
                      {took !== null && it.state !== 'failed' ? <span className="crewc-live-time">{formatElapsed(took)}</span> : null}
                      {it.count > 1 ? <span className="crewc-live-time">×{it.count}</span> : null}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <LiveStrip log={model.feed.log.map((e) => ({ key: e.key, at: e.at, text: eventText(e, t), kind: e.kind }))} />
      {onOpenBig ? (
        <button type="button" className="wfl-big" data-testid="wf-open-big" onClick={onOpenBig}>
          {t('wfdock.openBig')}
        </button>
      ) : null}
    </div>
  );
}
