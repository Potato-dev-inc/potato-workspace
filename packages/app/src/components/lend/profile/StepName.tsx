import { useT } from '../../../i18n';
import { borrowedName, offerable, supportTag, type LendState } from '../../../lib/lend';

/** Step 1: the name the other PC sees, and ONE agent (a sign-in belongs to one agent). */
export function StepName({
  state,
  owner,
  name,
  agentId,
  onName,
  onAgent,
  showErrors,
}: {
  state: LendState;
  /** My name, for the live "They will see" line (the borrower sees `<owner>'s <name>`). */
  owner: string;
  name: string;
  agentId: string;
  onName: (v: string) => void;
  onAgent: (id: string) => void;
  /** After a Next that was refused: the reasons show next to the fields. */
  showErrors: boolean;
}) {
  const t = useT();
  const agents = offerable(state.drivers);
  const picked = state.drivers.find((d) => d.agent_id === agentId);
  const shown = name.trim() || t('lend.name.placeholder');
  const nameError = showErrors && !name.trim() ? t('lend.problem.name') : null;
  const agentError = showErrors && !agentId ? t('lend.problem.oneAgent') : null;
  return (
    <div className="lend-step" data-step="name">
      <label className="lend-field">
        <span>{t('lend.name')}</span>
        <input
          type="text"
          aria-label={t('lend.name')}
          aria-invalid={nameError ? true : undefined}
          aria-describedby="lend-name-help"
          value={name}
          maxLength={60}
          placeholder={t('lend.name.placeholder')}
          autoFocus
          onChange={(e) => onName(e.target.value)}
        />
        <small id="lend-name-help" className="lend-note">
          {t('lend.name.help')}
        </small>
        {nameError && (
          <small className="lend-error" role="alert">
            {nameError}
          </small>
        )}
      </label>
      <p className="lend-preview" data-testid="lend-name-preview">
        {t('lend.name.preview', {
          name: borrowedName(picked?.label ?? agents[0]?.label ?? t('lend.agent'), { peer_name: owner, peer_device_name: '', for_other_person: true, profile_name: shown }),
        })}
      </p>
      <fieldset className="lend-cards" aria-label={t('lend.agents')}>
        <legend className="lend-legend">{t('lend.agents')}</legend>
        {agents.map((d) => (
          <label key={d.agent_id} className="lend-card" data-on={agentId === d.agent_id ? 'true' : undefined}>
            <input type="radio" name="lend-agent" checked={agentId === d.agent_id} onChange={() => onAgent(d.agent_id)} />
            <span className="lend-card-text">
              <strong>{d.label}</strong>
            </span>
            {!d.account && <span className="lend-tag">{t('lend.tag.keyOnly')}</span>}
            {d.support === 'lab' && <span className="lend-tag">{supportTag(d.support)}</span>}
          </label>
        ))}
        {agentError && (
          <small className="lend-error" role="alert">
            {agentError}
          </small>
        )}
      </fieldset>
    </div>
  );
}
