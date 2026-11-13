import { useT } from '../../i18n';
import { otherPersonWarning } from '../../lib/lend';
import '../../styles/lend.css';

/**
 * The box shown when lending to another person. "Lend" stays off until "I understand" is ticked.
 * The words are the founder's (plan share-an-agent, section 4); the tick is asked again for every grant.
 */
export function LendWarning({ agent, checked, onChange }: { agent: string; checked: boolean; onChange: (checked: boolean) => void }) {
  const t = useT();
  const w = otherPersonWarning(agent);
  return (
    <div className="lend-warning" role="group" aria-label={t('lend.risk.aria')} data-lend-warning="">
      <strong>{w.head}</strong>
      {w.lines.map((l) => (
        <p key={l}>{l}</p>
      ))}
      <label className="lend-tick">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span>{w.tick}</span>
      </label>
    </div>
  );
}
