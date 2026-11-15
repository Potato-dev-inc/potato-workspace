// Settings > Agents > Standby helpers: helpers you make yourself ("Reviewer · Codex · gpt-5" in this project). They start,
// wait with no tokens used, and the next task that fits one uses it. The same list feeds the top bar's "Ready" chips
// (`useStandbyHelpers`). Backed by `standby::helpers` and the warm chat pool.
import { useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useT, type MessageKey } from '../../../i18n';
import { useAgentRegistry } from '../../../lib/agentRegistry';
import { errorSentence } from '../../../lib/sayError';
import { tauriModelOptionsApi, useModelOptions, type ModelOptionsApi } from '../../../lib/modelOptions';
import { tauriStandbyHelpersApi, useStandbyHelpers, type AfterTask, type StandbyHelperEntry, type StandbyHelpersApi, type StandbyHelpersView } from '../../../lib/standbyHelpers';
import { ModelPicker } from '../../common/ModelPicker';
import { NumberControl, Popup, TextControl } from '../controls';
import { Btn, Note, SettingBlock } from '../settings-ui';

type Change = () => Promise<StandbyHelpersView | null>;

interface Props {
  api?: StandbyHelpersApi;
  modelApi?: ModelOptionsApi;
  /** The project folder setting: the form starts with it. */
  defaultProject?: string | null;
  onSaved?: () => void;
}

export function StandbyHelpersSettings({ api = tauriStandbyHelpersApi, modelApi = tauriModelOptionsApi, defaultProject, onSaved }: Props) {
  const t = useT();
  const { view, loaded, apply } = useStandbyHelpers(api);
  const [error, setError] = useState<string | null>(null);
  const atLimit = view.helpers.length >= view.max;

  const run = async (change: Change) => {
    setError(null);
    try {
      apply(await change());
      onSaved?.();
    } catch (e) {
      setError(errorSentence(e));
    }
  };

  return (
    <>
      <SettingBlock label={t('standby.listLabel')} description={t('standby.help')}>
        <div className="space-y-2" data-testid="standby-list">
          {loaded && view.helpers.length === 0 && <p className="text-sm text-pm-muted">{t('standby.empty')}</p>}
          {view.helpers.map((helper) => (
            <StandbyRow key={helper.id} helper={helper} onChange={run} api={api} />
          ))}
          {error && <Note role="alert">{error}</Note>}
        </div>
      </SettingBlock>
      <SettingBlock label={t('standby.newLabel')} description={atLimit ? t('standby.atLimit', { count: view.helpers.length }) : t('standby.newHelp')}>
        <NewStandbyForm disabled={atLimit} api={api} modelApi={modelApi} defaultProject={defaultProject ?? ''} onDone={run} />
      </SettingBlock>
      <SettingBlock label={t('standby.limitsLabel')} description={t('standby.limitsHelp')}>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <label className="flex items-center gap-2">
            {t('standby.max')}
            <NumberControl min={1} max={10} aria-label={t('standby.maxAria')} value={view.max} onCommit={(max) => run(() => api.setLimits(max, view.idle_minutes))} />
          </label>
          <label className="flex items-center gap-2">
            {t('standby.idle')}
            <NumberControl min={1} max={1440} aria-label={t('standby.idleAria')} value={view.idle_minutes} onCommit={(minutes) => run(() => api.setLimits(view.max, minutes))} />
            {t('standby.minutes')}
          </label>
        </div>
      </SettingBlock>
    </>
  );
}

function modelText(helper: StandbyHelperEntry, own: string): string {
  return helper.model ? `${own} · ${helper.model}` : own;
}

function StandbyRow({ helper, onChange, api }: { helper: StandbyHelperEntry; onChange: (change: Change) => Promise<void>; api: StandbyHelpersApi }) {
  const t = useT();
  const registry = useAgentRegistry();
  const agentLabel = registry.agents.find((a) => a.id === helper.agent)?.label ?? helper.agent;
  const note = helper.state === 'problem' && helper.note ? t(`standby.note.${helper.note}` as MessageKey) : null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-pm-border px-3 py-2" data-testid={`standby-row-${helper.id}`}>
      <TextControl
        mode="blur"
        className="w-44"
        aria-label={t('standby.renameAria', { name: helper.name })}
        value={helper.name}
        normalize={(text) => text.trim()}
        onCommit={(name) => (name ? onChange(() => api.update(helper.id, { name })) : undefined)}
      />
      <span className="text-sm text-pm-muted">{modelText(helper, agentLabel)}</span>
      <span className="text-sm font-medium" data-testid={`standby-state-${helper.id}`}>
        {t(`standby.state.${helper.state}`)}
      </span>
      <span className="font-mono text-xs text-pm-muted">{helper.project}</span>
      {note && <span className="text-xs text-pm-text">{note}</span>}
      <Popup aria-label={t('standby.afterAria', { name: helper.name })} value={helper.after_task} onChange={(e) => void onChange(() => api.update(helper.id, { after_task: e.target.value as AfterTask }))}>
        <option value="wait">{t('standby.after.wait')}</option>
        <option value="close">{t('standby.after.close')}</option>
      </Popup>
      {(helper.state === 'asleep' || helper.state === 'problem') && helper.note !== 'needs_chat' && helper.note !== 'folder_missing' && (
        <Btn small onClick={() => void onChange(() => api.start(helper.id))}>
          {t('standby.start')}
        </Btn>
      )}
      <Btn small aria-label={t('standby.removeAria', { name: helper.name })} onClick={() => void onChange(() => api.remove(helper.id))}>
        {t('standby.remove')}
      </Btn>
    </div>
  );
}

export function NewStandbyForm({ api, modelApi = tauriModelOptionsApi, defaultProject, disabled, onDone, onCancel }: { onCancel?: () => void; api: StandbyHelpersApi; modelApi?: ModelOptionsApi; defaultProject: string; disabled: boolean; onDone: (change: Change) => Promise<void> }) {
  const t = useT();
  const registry = useAgentRegistry();
  const agents = registry.agents.filter((a) => a.installed && a.kind !== 'shell');
  const [name, setName] = useState('');
  const [agent, setAgent] = useState('');
  const [model, setModel] = useState('');
  const [project, setProject] = useState(defaultProject);
  const [after, setAfter] = useState<AfterTask>('wait');
  const agentId = agent || agents[0]?.id || '';
  const options = useModelOptions(agentId, modelApi);

  const browse = async () => {
    try {
      const picked = await openDialog({ directory: true, multiple: false, defaultPath: project.trim() || undefined });
      if (typeof picked === 'string') setProject(picked);
    } catch {
      // The dialog is only in the desktop app.
    }
  };
  const ready = name.trim() !== '' && agentId !== '' && project.trim() !== '' && !disabled;
  const add = () =>
    onDone(async () => {
      const next = await api.add({ name: name.trim(), agent: agentId, model: model.trim() || null, project: project.trim(), after_task: after });
      setName('');
      setModel('');
      return next;
    });

  return (
    <form
      className="grid max-w-xl gap-2 text-sm"
      data-testid="standby-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) void add();
      }}
    >
      <label className="grid gap-1">
        {t('standby.field.name')}
        <input className="st-field" aria-label={t('standby.field.name')} placeholder={t('standby.field.namePlaceholder')} value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="grid gap-1">
        {t('standby.field.agent')}
        <Popup
          aria-label={t('standby.field.agent')}
          value={agentId}
          onChange={(e) => {
            setAgent(e.target.value);
            setModel('');
          }}
        >
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </Popup>
      </label>
      <div className="grid gap-1">
        {t('standby.field.model')}
        {agentId && <ModelPicker testId="standby-model" label={t('standby.field.model')} state={options} value={model} onChange={setModel} defaultWord={t('models.agentDefault')} />}
      </div>
      <label className="grid gap-1">
        {t('standby.field.project')}
        <span className="flex gap-2">
          <input className="st-field is-mono" aria-label={t('standby.field.project')} value={project} onChange={(e) => setProject(e.target.value)} />
          <Btn onClick={() => void browse()}>{t('standby.browse')}</Btn>
        </span>
      </label>
      <label className="grid gap-1">
        {t('standby.field.after')}
        <Popup aria-label={t('standby.field.after')} value={after} onChange={(e) => setAfter(e.target.value as AfterTask)}>
          <option value="wait">{t('standby.after.wait')}</option>
          <option value="close">{t('standby.after.close')}</option>
        </Popup>
      </label>
      <div>
        <Btn primary type="submit" disabled={!ready}>
          {t('standby.add')}
        </Btn>
        {onCancel && (
          <Btn className="ml-2" onClick={onCancel}>
            {t('standby.cancel')}
          </Btn>
        )}
      </div>
    </form>
  );
}
