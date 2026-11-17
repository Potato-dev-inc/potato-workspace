// The "Role" panel of the canvas: what one box is called, which agent and model it uses, what it does, what it may do,
// how many helpers it keeps ready, and who it hands work to. Everything is a plain control; the crew changes at once
// (nothing is saved until Save). A ready-made crew shows the same fields, switched off.
import { useT } from '../../i18n';
import { useModelOptions } from '../../lib/modelOptions';
import { ModelPicker } from '../common/ModelPicker';
import { DEFAULT_AGENT, type Crew, type CrewAgents, type CrewPermissions, type CrewRole } from '../../lib/crews-api';
import type { ModelNamer } from './modelNames';
import { MAX_STANDBYS, keyOf, setPermissions, setRole, renameRole, toggleHandoff, isCalled, isWorkflow, kindOf, setFront } from './model';

const WRITES = ['none', 'worktree', 'scoped'] as const;
const RUNS = ['none', 'read-only', 'worktree', 'ask'] as const;

export function RoleEditor({
  crew,
  index,
  agents,
  disabled,
  modelName,
  workflows = false,
  onChange,
  onRemove,
}: {
  crew: Crew;
  index: number;
  agents: CrewAgents | null;
  disabled: boolean;
  modelName: ModelNamer;
  /** Labs "Workflows" is on: the lead may be marked the Front of a workflow. */
  workflows?: boolean;
  onChange: (next: Crew) => void;
  onRemove: () => void;
}) {
  const t = useT();
  const role = crew.roles[index];
  const models = useModelOptions(role ? role.agent_type : null);
  if (!role) return <p className="crewc-hint">{t('crewcanvas.pick')}</p>;
  const rights: CrewPermissions = role.permissions ?? { read: true, write: 'none', run: 'none', start_helpers: false, merge: false };
  const patch = (change: Partial<CrewRole>) => onChange(setRole(crew, index, change));
  const allow = (change: Partial<CrewPermissions>) => onChange(setPermissions(crew, index, change));
  const choices = agents?.agents ?? [];
  const known = choices.some((a) => a.id === role.agent_type);
  const others = crew.roles.filter((r) => r !== role);
  const isLead = !role.parent;
  const inWorkflow = isWorkflow(crew);
  const showFront = workflows || inWorkflow;

  return (
    <div className="crewc-editor" data-testid="role-editor">
      <label className="crewc-field">
        <span>{t('crewcanvas.role.name')}</span>
        <input type="text" value={role.name} maxLength={40} disabled={disabled} onChange={(e) => onChange(renameRole(crew, index, e.target.value))} />
      </label>
      <label className="crewc-field">
        <span>{t('crewcanvas.role.agent')}</span>
        <select value={role.agent_type} disabled={disabled} onChange={(e) => patch({ agent_type: e.target.value })}>
          {!known ? <option value={role.agent_type}>{role.agent_type === DEFAULT_AGENT ? t('crewcanvas.agent.default') : role.agent_type}</option> : null}
          {choices.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
      </label>
      <div className="crewc-field">
        <span>{t('crewcanvas.role.model')}</span>
        {/* The same model menu as everywhere else; "agent's default" is the blank choice. */}
        {disabled ? (
          <span className="crewc-static">{role.model ? modelName(role.agent_type, role.model) : t('models.agentDefault')}</span>
        ) : (
          <ModelPicker
            testId="crew-role-model"
            label={t('crewcanvas.role.model')}
            state={models}
            value={role.model ?? ''}
            onChange={(value) => patch({ model: value || null })}
            defaultWord={t('models.agentDefault')}
          />
        )}
      </div>
      {showFront && isLead ? (
        <label className="crewc-check" data-testid="role-front">
          <input type="checkbox" checked={!!role.front} disabled={disabled} onChange={(e) => onChange(setFront(crew, e.target.checked, t('crewcanvas.wf.whenStart')))} />
          <span>{t('crewcanvas.wf.front')}</span>
        </label>
      ) : null}
      {inWorkflow && !role.front ? (
        <>
          <label className="crewc-field">
            <span>{t('crewcanvas.wf.when')}</span>
            <input type="text" value={role.when_to_use ?? ''} maxLength={120} disabled={disabled} data-testid="role-when" placeholder={t('crewcanvas.wf.whenHint')} onChange={(e) => patch({ when_to_use: e.target.value })} />
          </label>
          <label className="crewc-field">
            <span>{t('crewcanvas.wf.kind')}</span>
            <select value={kindOf(role)} disabled={disabled} data-testid="role-kind" onChange={(e) => patch({ kind: e.target.value === 'spin_off' ? 'spin_off' : null })}>
              <option value="minion">{t('crewcanvas.wf.kind.minion')}</option>
              <option value="spin_off">{t('crewcanvas.wf.kind.spin_off')}</option>
            </select>
          </label>
        </>
      ) : null}
      <label className="crewc-field">
        <span>{t('crewcanvas.role.job')}</span>
        <textarea rows={5} value={role.task} disabled={disabled} onChange={(e) => patch({ task: e.target.value })} />
      </label>

      <fieldset className="crewc-rights" disabled={disabled}>
        <legend>{t('crewcanvas.role.rights')}</legend>
        <label className="crewc-check">
          <input type="checkbox" checked={rights.read} onChange={(e) => allow({ read: e.target.checked })} />
          <span>{t('crewcanvas.role.read')}</span>
        </label>
        <label className="crewc-field">
          <span>{t('crewcanvas.role.write')}</span>
          <select value={rights.write} onChange={(e) => allow({ write: e.target.value as CrewPermissions['write'] })}>
            {WRITES.map((w) => (
              <option key={w} value={w}>
                {t(`crewcanvas.write.${w}` as never)}
              </option>
            ))}
          </select>
        </label>
        {rights.write === 'scoped' ? (
          <label className="crewc-field">
            <span>{t('crewcanvas.role.scope')}</span>
            <input type="text" value={rights.write_scope ?? ''} onChange={(e) => allow({ write_scope: e.target.value || null })} />
          </label>
        ) : null}
        <label className="crewc-field">
          <span>{t('crewcanvas.role.run')}</span>
          <select value={rights.run} onChange={(e) => allow({ run: e.target.value as CrewPermissions['run'] })}>
            {RUNS.map((r) => (
              <option key={r} value={r}>
                {t(`crewcanvas.run.${r}` as never)}
              </option>
            ))}
          </select>
        </label>
        <label className="crewc-check">
          <input type="checkbox" checked={rights.start_helpers} onChange={(e) => allow({ start_helpers: e.target.checked })} />
          <span>{t('crewcanvas.role.startHelpers')}</span>
        </label>
        {/* Only the lead may merge: the crew check refuses it for anyone else. */}
        {isLead ? (
          <label className="crewc-check">
            <input type="checkbox" checked={rights.merge} onChange={(e) => allow({ merge: e.target.checked })} />
            <span>{t('crewcanvas.role.merge')}</span>
          </label>
        ) : null}
        <p className="crewc-hint">{t('crewcanvas.role.rightsNote')}</p>
      </fieldset>

      <label className="crewc-field">
        <span>{t('crewcanvas.role.ready')}</span>
        <input
          type="number"
          min={0}
          max={MAX_STANDBYS}
          value={role.standbys ?? 0}
          disabled={disabled}
          onChange={(e) => patch({ standbys: Math.min(MAX_STANDBYS, Math.max(0, Math.round(Number(e.target.value) || 0))) })}
        />
      </label>
      <label className="crewc-check">
        <input type="checkbox" checked={!!role.check} disabled={disabled} onChange={(e) => patch({ check: e.target.checked })} />
        <span>{t('crewcanvas.role.check')}</span>
      </label>

      {others.length > 0 ? (
        <fieldset className="crewc-rights" disabled={disabled}>
          <legend>{t('crewcanvas.role.hands')}</legend>
          {others.map((o) => (
            <label key={keyOf(o)} className="crewc-check">
              <input type="checkbox" checked={(role.hands_to ?? []).some((h) => isCalled(o, h))} onChange={() => onChange(toggleHandoff(crew, index, crew.roles.indexOf(o)))} />
              <span>{o.name}</span>
            </label>
          ))}
        </fieldset>
      ) : null}

      {!isLead && !disabled ? (
        <button type="button" className="crewc-btn crewc-btn--quiet" onClick={onRemove}>
          {t('crewcanvas.role.remove')}
        </button>
      ) : null}
    </div>
  );
}
