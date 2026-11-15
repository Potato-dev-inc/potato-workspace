import { useEffect, useState } from 'react';
import { useT } from '../../../i18n';
import { type NewWorkflow, type RoutineAgent, type Step, routinesApi, routinesError } from '../../../lib/routines';

type Mode = 'send' | 'start' | 'tell';

/** What a chain made from the sheet does, as the engine's JSON (see `lib/routines.ts`). */
export function thenWorkflow(input: { paneId: string; onlyIfOk: boolean; mode: Mode; text: string; agent: string; project: string; name: string }): NewWorkflow {
  const steps: Step[] =
    input.mode === 'send'
      ? [{ kind: 'follow_up', text: input.text.trim() }]
      : input.mode === 'start'
        ? [{ kind: 'start_agent', agent: input.agent, project: input.project, task: input.text.trim(), separate_copy: false }, { kind: 'wait' }]
        : [{ kind: 'notify', text: input.text.trim() }];
  return { name: input.name, trigger: { kind: 'chat_finished', pane_id: input.paneId, only_if_ok: input.onlyIfOk }, steps };
}

/** "Then…" on a chat's result: add one chain step that runs when this chat finishes ("after this, do that"). */
export function ThenSheet({ paneId, cwd, onClose, onAdded }: { paneId: string; cwd: string; onClose: () => void; onAdded: () => void }) {
  const t = useT();
  const [mode, setMode] = useState<Mode>('send');
  const [text, setText] = useState('');
  const [onlyIfOk, setOnlyIfOk] = useState(true);
  const [agents, setAgents] = useState<RoutineAgent[]>([]);
  const [agent, setAgent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.resolve()
      .then(() => routinesApi.agents())
      .then((list) => {
        if (!alive) return;
        setAgents(list);
        setAgent((cur) => cur || list[0]?.id || '');
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const prompt = mode === 'send' ? t('routines.then.message') : mode === 'start' ? t('routines.then.task') : t('routines.then.tellText');
  const what = mode === 'send' ? t('routines.then.nameSend') : mode === 'start' ? t('routines.then.nameStart') : t('routines.then.nameTell');

  async function add() {
    setBusy(true);
    setError(null);
    try {
      const body = text.trim() || (mode === 'tell' ? t('routines.then.tellDefault') : '');
      await routinesApi.create(thenWorkflow({ paneId, onlyIfOk, mode, text: body, agent, project: cwd, name: t('routines.then.name', { what }) }));
      onAdded();
    } catch (e) {
      setError(routinesError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="ck-routines-then"
      role="group"
      aria-label={t('routines.then.title')}
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
    >
      <div className="ck-caption">{t('routines.then.title')}</div>
      <div className="ck-seg" role="radiogroup" aria-label={t('routines.then.title')}>
        {(['send', 'start', 'tell'] as const).map((m) => (
          <button key={m} type="button" role="radio" aria-checked={mode === m} className={`ck-seg-opt${mode === m ? ' is-on' : ''}`} onClick={() => setMode(m)}>
            {t(m === 'send' ? 'routines.then.send' : m === 'start' ? 'routines.then.start' : 'routines.then.tell')}
          </button>
        ))}
      </div>
      {mode === 'start' && agents.length > 0 && (
        <label className="ck-routines-field">
          <span>{t('routines.then.agent')}</span>
          <select className="ck-routines-select" value={agent} onChange={(e) => setAgent(e.target.value)}>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="ck-routines-field">
        <span>{prompt}</span>
        <textarea className="ck-routines-input ck-routines-task" rows={2} value={text} placeholder={mode === 'tell' ? t('routines.then.tellDefault') : ''} onChange={(e) => setText(e.target.value)} />
      </label>
      <label className="ck-routines-check">
        <input type="checkbox" checked={onlyIfOk} onChange={(e) => setOnlyIfOk(e.target.checked)} />
        {t('routines.then.only')}
      </label>
      {error && (
        <p className="ck-routines-error" role="alert">
          {error}
        </p>
      )}
      <div className="ck-routines-actions">
        <button type="submit" className="ck-btn ck-btn--primary" disabled={busy || (mode !== 'tell' && !text.trim()) || (mode === 'start' && !agent)}>
          {t('routines.then.add')}
        </button>
        <button type="button" className="ck-btn ck-btn--plain" onClick={onClose}>
          {t('routines.then.cancel')}
        </button>
      </div>
    </form>
  );
}
