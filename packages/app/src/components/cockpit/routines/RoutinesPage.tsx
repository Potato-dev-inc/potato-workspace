import { useEffect, useState } from 'react';
import { type MessageKey, useLanguage, useT } from '../../../i18n';
import { type RoutineAgent, type RunView, routinesApi, routinesError, useRoutines } from '../../../lib/routines';
import { LimitRow } from './LimitRow';
import { RoutineForm } from './RoutineForm';
import { WorkflowRow } from './WorkflowRow';
import { formatWhen, noteText } from './routines-text';

/**
 * Routines: agents that start by themselves (a time of day), and chains ("after this chat, do that"). One engine
 * behind both. Also "At most N at once" and its waiting line.
 */
export function RoutinesPage({ onClose, defaultProject }: { onClose: () => void; defaultProject?: string }) {
  const t = useT();
  const lang = useLanguage();
  const { view, ready, error, reload } = useRoutines();
  const [agents, setAgents] = useState<RoutineAgent[]>([]);
  const [formOpen, setFormOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.resolve()
      .then(() => routinesApi.agents())
      .then((list) => alive && setAgents(list))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const agentLabel = (id: string) => agents.find((a) => a.id === id)?.label ?? id;
  const routines = view.workflows.filter((w) => w.kind !== 'chain');
  const chains = view.workflows.filter((w) => w.kind === 'chain');

  async function act(job: () => Promise<unknown>) {
    setBusy(true);
    setProblem(null);
    try {
      await job();
      reload();
    } catch (e) {
      setProblem(routinesError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ck-routines" data-testid="routines-page">
      <header className="ck-routines-head">
        <div>
          <h1 className="ck-title">{t('routines.title')}</h1>
          <p className="ck-sub">{t('routines.sub')}</p>
        </div>
        <div className="ck-routines-head-actions">
          <button type="button" className="ck-btn ck-btn--primary" onClick={() => setFormOpen(true)} disabled={formOpen}>
            {t('routines.new')}
          </button>
          <button type="button" className="ck-btn ck-btn--plain" onClick={onClose}>
            {t('routines.close')}
          </button>
        </div>
      </header>

      {(error || problem) && (
        <p className="ck-routines-error" role="alert">
          {problem ?? error ?? t('routines.error.generic')}
        </p>
      )}

      <LimitRow limit={view.limit} running={view.running} disabled={busy} onChange={(limit) => void act(() => routinesApi.setLimit(limit))} />

      {view.queue.length > 0 && (
        <section className="ck-routines-section" aria-label={t('routines.section.queue')} data-testid="routines-queue">
          <h2 className="ck-routines-h">{t('routines.section.queue')}</h2>
          <p className="ck-sub">{t('routines.queue.line', { count: view.running })}</p>
          <ol className="ck-routines-queue">
            {view.queue.map((q) => (
              <li key={q.runId} className="ck-routines-queue-row">
                <strong>{q.name}</strong>
                <span className="ck-sub">{t('routines.queue.position', { position: q.position })}</span>
                <button type="button" className="ck-btn ck-btn--plain" disabled={busy} onClick={() => void act(() => routinesApi.stopRun(q.runId))}>
                  {t('routines.stop')}
                </button>
              </li>
            ))}
          </ol>
        </section>
      )}

      {formOpen && (
        <RoutineForm
          agents={agents}
          defaultProject={defaultProject}
          onCancel={() => setFormOpen(false)}
          onSaved={() => {
            setFormOpen(false);
            reload();
          }}
        />
      )}

      <section className="ck-routines-section" aria-label={t('routines.section.routines')}>
        <h2 className="ck-routines-h">{t('routines.section.routines')}</h2>
        {!ready ? (
          <p className="ck-sub">{t('routines.loading')}</p>
        ) : routines.length === 0 ? (
          <p className="ck-sub" data-testid="routines-empty">{t('routines.empty')}</p>
        ) : (
          <ul className="ck-routines-list">
            {routines.map((w) => (
              <WorkflowRow
                key={w.id}
                w={w}
                agentLabel={agentLabel}
                busy={busy}
                onRunNow={() => void act(() => routinesApi.runNow(w.id))}
                onToggle={() => void act(() => routinesApi.setEnabled(w.id, !w.enabled))}
                onDelete={() => void act(() => routinesApi.remove(w.id))}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="ck-routines-section" aria-label={t('routines.section.chains')}>
        <h2 className="ck-routines-h">{t('routines.section.chains')}</h2>
        {chains.length === 0 ? (
          <p className="ck-sub">{t('routines.noChains')}</p>
        ) : (
          <ul className="ck-routines-list">
            {chains.map((w) => (
              <WorkflowRow
                key={w.id}
                w={w}
                agentLabel={agentLabel}
                busy={busy}
                onRunNow={() => void act(() => routinesApi.runNow(w.id))}
                onToggle={() => void act(() => routinesApi.setEnabled(w.id, !w.enabled))}
                onDelete={() => void act(() => routinesApi.remove(w.id))}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="ck-routines-section" aria-label={t('routines.section.recent')}>
        <h2 className="ck-routines-h">{t('routines.section.recent')}</h2>
        {view.runs.length === 0 ? (
          <p className="ck-sub">{t('routines.noRuns')}</p>
        ) : (
          <ul className="ck-routines-runs">
            {view.runs.slice(0, 12).map((r) => (
              <RunLine key={r.id} run={r} lang={lang} busy={busy} onStop={() => void act(() => routinesApi.stopRun(r.id))} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function RunLine({ run, lang, busy, onStop }: { run: RunView; lang: string; busy: boolean; onStop: () => void }) {
  const t = useT();
  const note = noteText(run, t, lang);
  return (
    <li className="ck-routines-run" data-state={run.state}>
      <span className="ck-routines-run-name">{run.name}</span>
      <span className="ck-routines-pill">{t(`routines.state.${run.state}` as MessageKey)}</span>
      <span className="ck-sub">{formatWhen(run.createdMs, lang)}</span>
      {run.state === 'running' && <span className="ck-sub">{t('routines.runStep', { step: Math.min(run.step + 1, run.stepCount), count: run.stepCount })}</span>}
      {note && <span className="ck-sub">{note}</span>}
      {(run.state === 'running' || run.state === 'waiting') && (
        <button type="button" className="ck-btn ck-btn--plain" disabled={busy} onClick={onStop}>
          {t('routines.stop')}
        </button>
      )}
    </li>
  );
}
