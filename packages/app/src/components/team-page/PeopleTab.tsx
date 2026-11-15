import { useState } from 'react';
import { useT } from '../../i18n';
import { errorSentence } from '../../lib/sayError';
import type { ShareView, TeamApi, TeamConfigView } from '../../lib/team';
import { initials, personHue } from './person-color';
import { ShareSheet } from './ShareSheet';
import { busyLine, presenceWords, shareLine, workingLine, type Person } from './team-page-model';

const ROLE = { admin: 'teamHub.role.admin', approve: 'teamHub.role.approve', watch: 'teamHub.role.watch' } as const;

/**
 * One card per person: me first, then here, away, not here. A teammate's words (name, project, chat title) are plain text,
 * cut by the Rust side; the project and title lines appear only when that person turned them on.
 */
export function PeopleTab({
  people,
  config,
  share,
  api,
  now,
  lendOn,
  onAskUsage,
  onChanged,
}: {
  people: Person[];
  config: TeamConfigView;
  share: ShareView;
  api: TeamApi;
  now: number;
  lendOn: boolean;
  onAskUsage: () => void;
  onChanged: () => void;
}) {
  const t = useT();
  const [sharing, setSharing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const answer = async (id: string, accept: boolean) => {
    setBusy(id);
    setError(null);
    try {
      await (accept ? api.approveJoin(id) : api.declineJoin(id));
      onChanged();
    } catch (err) {
      setError(errorSentence(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="tpg-people">
      {error && (
        <p className="tpg-error" role="alert">
          {error}
        </p>
      )}
      {config.admin && config.joins.length > 0 && (
        <ul className="tpg-joins" aria-label={t('teamHub.join.letIn')}>
          {config.joins.map((j) => (
            <li key={j.id} className="tpg-join">
              <span>{t('teamHub.join.wants', { name: j.name, device: j.device })}</span>
              {j.warning && <small className="tpg-warn">{j.warning}</small>}
              <span className="tpg-actions">
                <button type="button" className="ck-btn ck-btn--primary" disabled={busy === j.id} onClick={() => void answer(j.id, true)}>
                  {t('teamHub.join.letIn')}
                </button>
                <button type="button" className="ck-btn ck-btn--plain" disabled={busy === j.id} onClick={() => void answer(j.id, false)}>
                  {t('teamHub.join.no')}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <ul className="tpg-cards" aria-label={t('teamHub.people.list')}>
        {people.map((p) => {
          const m = p.member;
          const working = m.me ? null : workingLine(p.presence);
          const busyWords = m.me ? null : busyLine(p.presence);
          return (
            <li key={m.id} className="tpg-person" data-presence={p.kind} data-testid={`person-${m.id}`}>
              <span className="tpg-avatar" data-hue={personHue(m.id)} aria-hidden="true">
                {initials(m.name)}
              </span>
              <div className="tpg-person-main">
                <div className="tpg-person-head">
                  <strong className="tpg-name">{m.name}</strong>
                  {m.me && <span className="tpg-chip">{t('teamHub.you')}</span>}
                  <span className="tpg-presence" data-kind={p.kind}>
                    <span className="tpg-dot" aria-hidden="true" />
                    {m.me ? t('teamHub.presence.here') : presenceWords(p.presence, now)}
                  </span>
                </div>
                <p className="tpg-sub">
                  {t('teamHub.devices', { count: m.devices })}
                  {m.roles.length > 0 && ` · ${m.admin ? t(ROLE.admin) : t(ROLE[m.roles.includes('approve') ? 'approve' : 'watch'])}`}
                </p>
                {working && <p className="tpg-working">{working}</p>}
                {busyWords && <p className="tpg-sub">{busyWords}</p>}
                {m.me && (
                  <p className="tpg-sub tpg-see" data-testid="others-see">
                    {shareLine(share.level)}{' '}
                    <button type="button" className="tpg-link-btn" onClick={() => setSharing(true)}>
                      {t('teamHub.share.change')}
                    </button>
                  </p>
                )}
                {!m.me && lendOn && (
                  <div className="tpg-actions">
                    <button type="button" className="ck-btn ck-btn--secondary" onClick={onAskUsage}>
                      {t('teamHub.askUsage')}
                    </button>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {sharing && <ShareSheet share={share} api={api} onClose={() => setSharing(false)} onSaved={onChanged} />}
    </div>
  );
}
