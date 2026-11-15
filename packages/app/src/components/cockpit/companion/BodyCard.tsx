// How the companion feels (Labs: companion vault): a mood word, four thin meters, what it wants, and how long the
// person was away. Quiet on purpose. Hidden while the flag is off (the view then has no `body`).
import type { BodyView } from '../../../lib/companion';
import { useT } from '../../../i18n';

const clamp = (n: number): number => Math.max(0, Math.min(100, Number.isFinite(n) ? n : 0));

function Meter({ label, percent }: { label: string; percent: number }) {
  const value = Math.round(clamp(percent));
  return (
    <div className="ck-body-row">
      <span className="ck-body-label">{label}</span>
      <span className="ck-body-meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}>
        <span className="ck-body-meter-fill" style={{ width: `${value}%` }} />
      </span>
    </div>
  );
}

export function BodyCard({ name, body }: { name: string; body: BodyView }) {
  const t = useT();
  const mood = t(`companion.body.mood.${body.mood}`);
  const level = t(`companion.body.level.${body.intensity}`);
  const away = body.awayMinutes;
  const awayLine =
    away === null || away === undefined || away <= 0
      ? null
      : away >= 90
        ? t('companion.body.awayHours', { count: Math.round(away / 60) })
        : t('companion.body.away', { count: Math.max(1, Math.round(away)) });
  return (
    <section className="ck-companion-card" aria-labelledby="ck-companion-body-title">
      <h2 className="ck-companion-card-title" id="ck-companion-body-title">
        {t('companion.body.title', { name })}
      </h2>
      <p className="ck-body-mood" data-mood={body.mood}>
        <span className="ck-body-mood-word">{t('companion.body.moodLine', { mood, level })}</span>
      </p>
      {body.sleeping && <p className="ck-sub">{t('companion.body.sleeping')}</p>}
      <div className="ck-body-meters">
        <Meter label={t('companion.body.energy')} percent={body.energy} />
        <Meter label={t('companion.body.hunger')} percent={body.hunger} />
        <Meter label={t('companion.body.boredom')} percent={body.boredom} />
        <Meter label={t('companion.body.longing')} percent={body.longing} />
      </div>
      {body.drives.length > 0 && (
        <div className="ck-body-drives">
          <h3 className="ck-body-sub">{t('companion.body.drives')}</h3>
          {body.drives.slice(0, 4).map((drive) => (
            <div className="ck-body-row" key={drive.name} data-waiting={drive.waiting ? '' : undefined}>
              <span className="ck-body-label">
                {drive.waiting && <span className="ck-body-dot" role="img" aria-label={t('companion.body.waiting')} title={t('companion.body.waiting')} />}
                {drive.name}
              </span>
              <span
                className="ck-body-meter"
                role="meter"
                aria-label={drive.name}
                aria-valuemin={0}
                aria-valuemax={drive.max}
                aria-valuenow={Math.max(0, Math.min(drive.max, drive.value))}
              >
                <span className="ck-body-meter-fill" style={{ width: `${drive.max > 0 ? clamp((drive.value / drive.max) * 100) : 0}%` }} />
                {drive.max > 0 && <span className="ck-body-meter-mark" style={{ left: `${clamp((drive.threshold / drive.max) * 100)}%` }} />}
              </span>
            </div>
          ))}
        </div>
      )}
      {awayLine && <p className="ck-sub ck-body-away">{awayLine}</p>}
    </section>
  );
}
