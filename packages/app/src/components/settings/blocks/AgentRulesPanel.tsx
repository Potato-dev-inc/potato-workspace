// Settings > Agents > Rules for agents: Force yes per agent (with its warning), fences per project, and the starting
// settings every new agent picks up (pins), for every project or one. Each block saves through its own command; the app
// keeps the file itself (`agent_rules.json`), not settings.json, so a phone or an agent cannot loosen a rule.
import { useCallback, useEffect, useState } from 'react';
import { useT } from '../../../i18n';
import { useAgentRegistry } from '../../../lib/agentRegistry';
import { EMPTY_OVERVIEW, ruleError, rulesOf, tauriAgentRulesApi, type AgentRulesApi, type Pin, type RulesOverview } from '../../../lib/agentRules';
import { projectLabel, useSidebarProjects } from '../../../lib/sidebarProjects';
import { Btn, Note, SettingBlock, SettingToggle } from '../settings-ui';

function useOverview(api: AgentRulesApi) {
  const [overview, setOverview] = useState<RulesOverview>(EMPTY_OVERVIEW);
  const reload = useCallback(() => {
    api
      .overview()
      // An older build, or a shell that answers nothing: the panel starts empty instead of failing.
      .then((next) => setOverview(next && Array.isArray(next.projects) && Array.isArray(next.forceYesAgents) ? next : EMPTY_OVERVIEW))
      .catch(() => undefined);
  }, [api]);
  useEffect(reload, [reload]);
  return { overview, reload };
}

/** One switch per agent. Turning it on first shows what it does and asks. */
function ForceYesBlock({ api, overview, reload }: { api: AgentRulesApi; overview: RulesOverview; reload: () => void }) {
  const t = useT();
  const listing = useAgentRegistry();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const agents = listing.agents.filter((a) => a.installed && a.kind !== 'shell');
  const on = new Set(overview.forceYesAgents);
  const set = (id: string, value: boolean) => {
    setError(null);
    setConfirming(null);
    api
      .setForceYesAgent(id, value)
      .then(reload)
      .catch((e: unknown) => setError(t('rules.failed', { why: ruleError(e) })));
  };
  return (
    <SettingBlock label={t('rules.forceYesTitle')} description={t('rules.forceYesHelp')}>
      {agents.length === 0 && <small>{t('rules.noAgents')}</small>}
      {agents.map((agent) => (
        <div key={agent.id} data-testid={`rules-force-yes-${agent.id}`}>
          <SettingToggle
            label={t('rules.forceYesAgent', { agent: agent.label })}
            checked={on.has(agent.id.toLowerCase())}
            onChange={(value) => (value ? setConfirming(agent.id) : set(agent.id, false))}
          />
          {confirming === agent.id && (
            <div className="st-rules-block" role="alertdialog" aria-label={t('forceYes.warnTitle')}>
              <p>{t('forceYes.warnBody')}</p>
              <div className="st-rules-row">
                <Btn small onClick={() => setConfirming(null)}>
                  {t('forceYes.cancel')}
                </Btn>
                <Btn small primary data-testid={`rules-force-yes-confirm-${agent.id}`} onClick={() => set(agent.id, true)}>
                  {t('forceYes.turnOn')}
                </Btn>
              </div>
            </div>
          )}
        </div>
      ))}
      {error && <Note role="alert">{error}</Note>}
    </SettingBlock>
  );
}

function ProjectPick({ value, onChange }: { value: string; onChange: (path: string) => void }) {
  const t = useT();
  const { projects } = useSidebarProjects();
  if (projects.length === 0) return <small>{t('rules.noProjects')}</small>;
  return (
    <select aria-label={t('rules.project')} value={value} onChange={(e) => onChange(e.target.value)} data-testid="rules-project">
      {projects.map((p) => (
        <option key={p.path} value={p.path}>
          {projectLabel(p)}
        </option>
      ))}
    </select>
  );
}

function FencesBlock({ api, overview, reload }: { api: AgentRulesApi; overview: RulesOverview; reload: () => void }) {
  const t = useT();
  const { projects } = useSidebarProjects();
  const [picked, setPicked] = useState('');
  const project = picked || projects[0]?.path || '';
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const fences = project ? rulesOf(overview, project).fences : [];
  const act = (run: () => Promise<unknown>) => {
    setError(null);
    run()
      .then(reload)
      .catch((e: unknown) => setError(t('rules.failed', { why: ruleError(e) })));
  };
  return (
    <SettingBlock label={t('rules.fencesTitle')} description={t('rules.fencesHelp')}>
      <div className="st-rules-block">
        <ProjectPick value={project} onChange={setPicked} />
        {project && fences.length === 0 && <small>{t('rules.noFences')}</small>}
        {fences.length > 0 && (
          <ul className="st-rules-list" data-testid="rules-fences">
            {fences.map((fence) => (
              <li key={fence}>
                <span>{fence}</span>
                <Btn small aria-label={t('rules.fenceRemove', { fence })} onClick={() => act(() => api.fenceRemove(project, fence))}>
                  ×
                </Btn>
              </li>
            ))}
          </ul>
        )}
        {project && (
          <form
            className="st-rules-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (!text.trim()) return;
              act(() => api.fenceAdd(project, text.trim()).then(() => setText('')));
            }}
          >
            <input type="text" aria-label={t('rules.fenceLabel')} placeholder={t('rules.fencePlaceholder')} value={text} onChange={(e) => setText(e.target.value)} />
            <Btn small primary type="submit" disabled={!text.trim()}>
              {t('rules.fenceAdd')}
            </Btn>
          </form>
        )}
        {error && <Note role="alert">{error}</Note>}
      </div>
    </SettingBlock>
  );
}

const ALL = '';

function PinsBlock({ api, overview, reload }: { api: AgentRulesApi; overview: RulesOverview; reload: () => void }) {
  const t = useT();
  const { projects } = useSidebarProjects();
  const [scope, setScope] = useState(ALL);
  const saved: Pin = scope === ALL ? overview.pinGlobal : rulesOf(overview, scope).pin;
  const [draft, setDraft] = useState<Pin>(saved);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  // The draft follows what is saved (another window, a different scope).
  const savedKey = JSON.stringify(saved);
  useEffect(() => {
    setDraft(saved);
    setNote(null);
  }, [savedKey, scope]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = () => {
    setNote(null);
    api
      .pinSet(scope === ALL ? null : scope, draft)
      .then(() => {
        setNote({ text: t('rules.pinSaved'), bad: false });
        reload();
      })
      .catch((e: unknown) => setNote({ text: t('rules.failed', { why: ruleError(e) }), bad: true }));
  };
  const field = (key: 'model' | 'mode' | 'notes', value: string) => setDraft((d) => ({ ...d, [key]: value || null }));
  return (
    <SettingBlock label={t('rules.pinsTitle')} description={t('rules.pinsHelp')}>
      <div className="st-rules-block" data-testid="rules-pins">
        <select aria-label={t('rules.project')} value={scope} onChange={(e) => setScope(e.target.value)} data-testid="rules-pin-scope">
          <option value={ALL}>{t('rules.pinScopeAll')}</option>
          {projects.map((p) => (
            <option key={p.path} value={p.path}>
              {t('rules.pinScopeProject')}: {projectLabel(p)}
            </option>
          ))}
        </select>
        <label className="st-rules-row">
          <span>{t('rules.pinModel')}</span>
          <input type="text" value={draft.model ?? ''} onChange={(e) => field('model', e.target.value)} />
        </label>
        <label className="st-rules-row">
          <span>{t('rules.pinMode')}</span>
          <input type="text" value={draft.mode ?? ''} onChange={(e) => field('mode', e.target.value)} />
        </label>
        <SettingToggle label={t('rules.pinForceYes')} checked={draft.force_yes === true} onChange={(value) => setDraft((d) => ({ ...d, force_yes: value ? true : null }))} />
        <label className="st-rules-block">
          <span>{t('rules.pinNotes')}</span>
          <textarea value={draft.notes ?? ''} placeholder={t('rules.pinNotesPlaceholder')} onChange={(e) => field('notes', e.target.value)} />
        </label>
        {scope !== ALL && <small>{t('rules.fenceInherited')}</small>}
        <div className="st-rules-row">
          <Btn small primary data-testid="rules-pin-save" onClick={save}>
            {t('rules.pinSave')}
          </Btn>
          {note && <Note role={note.bad ? 'alert' : 'status'}>{note.text}</Note>}
        </div>
      </div>
    </SettingBlock>
  );
}

export function AgentRulesPanel({ api = tauriAgentRulesApi }: { api?: AgentRulesApi }) {
  const { overview, reload } = useOverview(api);
  return (
    <div className="st-rules" data-testid="agent-rules-panel">
      <ForceYesBlock api={api} overview={overview} reload={reload} />
      <FencesBlock api={api} overview={overview} reload={reload} />
      <PinsBlock api={api} overview={overview} reload={reload} />
    </div>
  );
}
