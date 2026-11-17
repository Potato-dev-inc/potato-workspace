// The crew-wide part of a workflow (Labs "Workflows"), shown on the canvas while the crew has a Front: the one shared note
// every role gets, how the workflow starts, and how many helper runs the front may start for each message.
import { useT } from '../../i18n';
import type { Crew } from '../../lib/crews-api';
import { DEFAULT_HELPER_CAP, MAX_HELPER_CAP, setHelperCap, setStartMode } from './model';

export function WorkflowPanel({ crew, disabled, onChange }: { crew: Crew; disabled: boolean; onChange: (next: Crew) => void }) {
  const t = useT();
  const mode = crew.start_mode === 'horde' ? 'horde' : 'front';
  return (
    <fieldset className="crewc-rights" disabled={disabled} data-testid="workflow-panel">
      <legend>{t('crewcanvas.wf.title')}</legend>
      <label className="crewc-field">
        <span>{t('crewcanvas.wf.note')}</span>
        <textarea rows={3} value={crew.how_i_work ?? ''} data-testid="wf-note" onChange={(e) => onChange({ ...crew, how_i_work: e.target.value || null })} />
      </label>
      <div className="crewc-radios" role="radiogroup" aria-label={t('crewcanvas.wf.mode')}>
        <span className="crewc-radios-label">{t('crewcanvas.wf.mode')}</span>
        {(['front', 'horde'] as const).map((m) => (
          <label key={m} className="crewc-check">
            <input type="radio" name="wf-mode" checked={mode === m} data-testid={`wf-mode-${m}`} onChange={() => onChange(setStartMode(crew, m))} />
            <span>{t(`crewcanvas.wf.mode.${m}` as never)}</span>
          </label>
        ))}
      </div>
      <label className="crewc-field">
        <span>{t('crewcanvas.wf.cap')}</span>
        <input type="number" min={1} max={MAX_HELPER_CAP} value={crew.helper_cap ?? DEFAULT_HELPER_CAP} data-testid="wf-cap" onChange={(e) => onChange(setHelperCap(crew, Number(e.target.value)))} />
      </label>
      <p className="crewc-hint">{t('crewcanvas.wf.capHint')}</p>
      <p className="crewc-hint">{t('crewcanvas.wf.twoTypes')}</p>
    </fieldset>
  );
}
