import { useEffect, useState } from 'react';
import { type MessageKey, useT } from '../../../i18n';
import { type RoutineAgent, routineSteps, routinesApi, routinesError } from '../../../lib/routines';

type Mode = 'every' | 'weekdays' | 'pick';
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];

/** The new routine form: when, project, agent, task, and whether to tell the person at the end. */
export function RoutineForm({ agents, defaultProject, onSaved, onCancel }: { agents: RoutineAgent[]; defaultProject?: string; onSaved: () => void; onCancel: () => void }) {
  const t = useT();
  const [name, setName] = useState('');
  const [mode, setMode] = useState<Mode>('weekdays');
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [time, setTime] = useState('09:00');
  const [project, setProject] = useState(defaultProject ?? '');
  const [agent, setAgent] = useState(agents[0]?.id ?? '');
  const [task, setTask] = useState('');
  const [copy, setCopy] = useState(true);
  const [tellMe, setTellMe] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The agent list arrives after the form opens.
  useEffect(() => {
    if (!agent && agents[0]) setAgent(agents[0].id);
  }, [agent, agents]);

  const chosenDays = mode === 'every' ? [] : mode === 'weekdays' ? [1, 2, 3, 4, 5] : days;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const label = name.trim();
      await routinesApi.create({
        name: label,
        trigger: { kind: 'schedule', days: chosenDays, time },
        steps: routineSteps({ agent, project: project.trim(), task, separateCopy: copy, notify: tellMe, notifyText: t('routines.form.notifyText', { name: label }) }),
      });
      onSaved();
    } catch (e) {
      setError(routinesError(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="ck-routines-form"
      aria-label={t('routines.form.title')}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h2 className="ck-routines-h">{t('routines.form.title')}</h2>
      <label className="ck-routines-field">
        <span>{t('routines.form.name')}</span>
        <input className="ck-routines-input" value={name} maxLength={60} placeholder={t('routines.form.namePlaceholder')} onChange={(e) => setName(e.target.value)} />
      </label>

      <fieldset className="ck-routines-field ck-routines-when">
        <legend>{t('routines.form.when')}</legend>
        <div className="ck-seg" role="radiogroup" aria-label={t('routines.form.when')}>
          {(['every', 'weekdays', 'pick'] as const).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={mode === m} className={`ck-seg-opt${mode === m ? ' is-on' : ''}`} onClick={() => setMode(m)}>
              {t(m === 'every' ? 'routines.form.everyDay' : m === 'weekdays' ? 'routines.form.weekdays' : 'routines.form.pickDays')}
            </button>
          ))}
        </div>
        {mode === 'pick' && (
          <div className="ck-routines-days" role="group" aria-label={t('routines.form.days')}>
            {ALL_DAYS.map((d) => (
              <label key={d} className="ck-routines-day">
                <input type="checkbox" checked={days.includes(d)} onChange={(e) => setDays((cur) => (e.target.checked ? [...cur, d] : cur.filter((x) => x !== d)))} />
                {t(`routines.day.${d}` as MessageKey)}
              </label>
            ))}
          </div>
        )}
        <label className="ck-routines-field ck-routines-time">
          <span>{t('routines.form.time')}</span>
          <input className="ck-routines-input" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </label>
      </fieldset>

      <label className="ck-routines-field">
        <span>{t('routines.form.project')}</span>
        <input className="ck-routines-input" value={project} placeholder={t('routines.form.projectPlaceholder')} onChange={(e) => setProject(e.target.value)} />
      </label>

      <label className="ck-routines-field">
        <span>{t('routines.form.agent')}</span>
        {agents.length > 0 ? (
          <select className="ck-routines-select" value={agent} onChange={(e) => setAgent(e.target.value)}>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        ) : (
          <span className="ck-sub">{t('routines.form.noAgents')}</span>
        )}
      </label>

      <label className="ck-routines-field">
        <span>{t('routines.form.task')}</span>
        <textarea className="ck-routines-input ck-routines-task" rows={3} value={task} placeholder={t('routines.form.taskPlaceholder')} onChange={(e) => setTask(e.target.value)} />
      </label>

      <label className="ck-routines-check">
        <input type="checkbox" checked={copy} onChange={(e) => setCopy(e.target.checked)} />
        {t('routines.form.copy')}
      </label>
      <label className="ck-routines-check">
        <input type="checkbox" checked={tellMe} onChange={(e) => setTellMe(e.target.checked)} />
        {t('routines.form.tellMe')}
      </label>

      {error && (
        <p className="ck-routines-error" role="alert">
          {error}
        </p>
      )}
      <div className="ck-routines-actions">
        <button type="submit" className="ck-btn ck-btn--primary" disabled={saving || agents.length === 0}>
          {saving ? t('routines.form.saving') : t('routines.form.save')}
        </button>
        <button type="button" className="ck-btn ck-btn--plain" onClick={onCancel}>
          {t('routines.form.cancel')}
        </button>
      </div>
    </form>
  );
}
