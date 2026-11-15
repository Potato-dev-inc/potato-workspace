import { useT } from '../../../i18n';

const CHOICES = [1, 2, 3, 4, 5, 6, 8, 10];

/** "At most N at once": a global limit of running agents. Off by default; extra starts wait in line. */
export function LimitRow({ limit, running, onChange, disabled }: { limit: number | null; running: number; onChange: (limit: number | null) => void; disabled?: boolean }) {
  const t = useT();
  const choices = limit !== null && !CHOICES.includes(limit) ? [...CHOICES, limit].sort((a, b) => a - b) : CHOICES;
  return (
    <section className="ck-routines-limit" aria-label={t('routines.limit.title')}>
      <label className="ck-routines-limit-label" htmlFor="routines-limit">
        {t('routines.limit.label')}
      </label>
      <select
        id="routines-limit"
        className="ck-routines-select"
        value={limit === null ? '' : String(limit)}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      >
        <option value="">{t('routines.limit.off')}</option>
        {choices.map((n) => (
          <option key={n} value={n}>
            {t('routines.limit.n', { count: n })}
          </option>
        ))}
      </select>
      <span className="ck-sub ck-routines-limit-hint">{t('routines.limit.hint')}</span>
      {limit !== null && <span className="ck-sub" data-testid="routines-running">{t('routines.limit.running', { count: running })}</span>}
    </section>
  );
}
