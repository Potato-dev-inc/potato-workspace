import { useState } from 'react';
import { useT } from '../../i18n';
import { agentLabel, borrowedName, cleanName, errText, isActiveIn, isActiveOut, leftText, lendApi, peerLabel, problemText, urgencyOf, usageText, type Grant, type LendApi } from '../../lib/lend';
import { openSettingsAt } from '../../lib/openSettingsAt';
import { teamApi, type TeamApi } from '../../lib/team';
import { IncomingRequestCard } from '../lend/IncomingRequestCard';
import { RequestUsage } from '../lend/RequestUsage';
import { TakeBack } from '../lend/TakeBack';
import type { LendHandle } from '../lend/useLend';

/**
 * Usage: who I lend to, who I borrow from, and requests waiting for my yes. Everything comes from the lend state that
 * already exists. A sign-in never shows here and never leaves its PC. While Labs "Share an agent" is off: one card.
 */
export function UsageTab({ lend, api = lendApi, team = teamApi }: { lend: LendHandle; api?: LendApi; team?: TeamApi }) {
  const t = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const state = lend.state;

  if (!lend.enabled || !state) {
    return (
      <div className="tpg-usage" data-testid="usage-off">
        <section className="tpg-card">
          <h3 className="tpg-h">{t('teamHub.usage.off')}</h3>
          <p className="tpg-sub">{t('teamHub.usage.offHelp')}</p>
          <button type="button" className="ck-btn ck-btn--secondary" onClick={() => openSettingsAt('general', 'lend-labs')}>
            {t('teamHub.usage.offButton')}
          </button>
        </section>
      </div>
    );
  }

  const asked = state.requests_in.filter((r) => r.state === 'open');
  const out = state.grants.filter((g) => isActiveOut(g, lend.now));
  const borrowed = state.grants.filter((g) => isActiveIn(g, lend.now));

  const act = async (g: Grant) => {
    setBusy(g.id);
    setError(null);
    try {
      await (g.direction === 'out' ? api.revoke(g.id) : api.giveBack(g.id));
      lend.refresh();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  };

  const row = (g: Grant) => {
    const agent = agentLabel(state, g.agent_id);
    const left = g.ends_ms - lend.now;
    const problem = problemText(g);
    const used = usageText(g);
    return (
      <li key={g.id} className="tpg-lend" data-testid={`grant-${g.id}`}>
        <div className="tpg-lend-main">
          <strong>{g.direction === 'out' ? (cleanName(g.profile_name) ? t('teamHub.usage.lentRow', { agent, profile: cleanName(g.profile_name), peer: g.peer_name }) : t('teamHub.usage.lentRowBare', { agent, peer: g.peer_name })) : borrowedName(agent, g)}</strong>
          {used && <small className="tpg-sub">{used}</small>}
          {problem && (
            <small className="tpg-warn" role="status">
              {problem}
            </small>
          )}
        </div>
        <span className="tpg-time" data-urgency={urgencyOf(left)}>
          {t('teamHub.usage.left', { time: leftText(left) })}
        </span>
        {g.direction === 'out' ? (
          <TakeBack profile={g.profile_name || agent} peer={peerLabel(g)} busy={busy === g.id} onConfirm={() => void act(g)} />
        ) : (
          <button type="button" className="lend-btn is-small" disabled={busy === g.id} onClick={() => void act(g)}>
            {t('lend.giveBack')}
          </button>
        )}
      </li>
    );
  };

  return (
    <div className="tpg-usage">
      <p className="tpg-promise">{t('teamHub.usage.promise')}</p>
      <div className="tpg-actions">
        <RequestUsage api={api} team={team} lend={lend} variant="settings" />
      </div>
      {error && (
        <p className="tpg-error" role="alert">
          {error}
        </p>
      )}
      {asked.length > 0 && (
        <section aria-label={t('teamHub.usage.waiting')}>
          <h3 className="tpg-h">{t('teamHub.usage.waiting')}</h3>
          <ul className="tpg-list">
            {asked.map((r) => (
              <li key={r.id}>
                <IncomingRequestCard request={r} state={state} api={api} now={lend.now} onDone={lend.refresh} />
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-label={t('teamHub.usage.lentOut')}>
        <h3 className="tpg-h">{t('teamHub.usage.lentOut')}</h3>
        {out.length > 0 ? <ul className="tpg-list">{out.map(row)}</ul> : <p className="tpg-sub">{t('teamHub.usage.none')}</p>}
      </section>
      <section aria-label={t('teamHub.usage.borrowed')}>
        <h3 className="tpg-h">{t('teamHub.usage.borrowed')}</h3>
        {borrowed.length > 0 ? <ul className="tpg-list">{borrowed.map(row)}</ul> : <p className="tpg-sub">{t('teamHub.usage.none')}</p>}
      </section>
    </div>
  );
}
