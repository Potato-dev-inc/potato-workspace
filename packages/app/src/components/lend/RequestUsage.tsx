import { useEffect, useMemo, useState } from 'react';
import { t, useT } from '../../i18n';
import { teamApi, type MemberView, type TeamApi } from '../../lib/team';
import { agentLabel, comingSoonAgents, comingSoonText, DEFAULT_SECS, durationProblem, durationWords, errText, lendApi, MAX_REASON, offerable, supportTag, type LendApi, type LendRequest, type LendState } from '../../lib/lend';
import { DurationField } from './Duration';
import { LendSheet } from './LendSheet';
import { useLend, type LendHandle } from './useLend';
import '../../styles/lend.css';

/** A place to ask: a teammate, or one of my own computers. `value` is `memberId|deviceId`. */
export interface Source {
  value: string;
  label: string;
  memberId: string;
  deviceId: string | null;
  mine: boolean;
}

/** My other computers first ("My PCs"), then the teammates. A member's devices come from the roster. */
export function sourcesOf(members: readonly MemberView[]): { mine: Source[]; others: Source[] } {
  const mine: Source[] = [];
  const others: Source[] = [];
  for (const m of members) {
    if (m.me) {
      const list = (m.deviceList ?? []).filter((d) => !d.current);
      if (list.length > 0) {
        for (const d of list) mine.push({ value: `${m.id}|${d.id}`, label: d.name, memberId: m.id, deviceId: d.id, mine: true });
      } else if (m.devices > 1) {
        mine.push({ value: `${m.id}|`, label: t('lend.request.myOtherPc'), memberId: m.id, deviceId: null, mine: true });
      }
    } else {
      others.push({ value: `${m.id}|`, label: m.name, memberId: m.id, deviceId: null, mine: false });
    }
  }
  return { mine, others };
}

/** Waiting / Ready / Said no. */
export const askStatus = (r: Pick<LendRequest, 'state'>): string => (r.state === 'open' ? t('lend.ask.waiting') : r.state === 'accepted' ? t('lend.ask.ready') : t('lend.ask.saidNo'));

const askWords = (r: LendRequest, state: LendState | null): string => `${r.member_name || t('lend.teammate')} · ${agentLabel(state, r.agent_id)} · ${durationWords(r.secs)}`;

/** The newest asks of mine that are still worth seeing: waiting, or answered in the last day. */
export const recentAsks = (state: LendState | null, now: number): LendRequest[] =>
  (state?.requests_out ?? []).filter((r) => r.state === 'open' || now - r.at_ms < 24 * 3600_000).slice(-3);

/**
 * "Request usage": a button, the sheet it opens, and the status of what was asked (Waiting / Ready / Said no).
 * It sits in Settings > Team and in Inbox > Team. Draws nothing while Share an agent is off.
 */
export function RequestUsage({
  api = lendApi,
  team = teamApi,
  lend,
  variant = 'inbox',
}: {
  api?: LendApi;
  team?: TeamApi;
  /** A parent that already reads the state shares it. */
  lend?: LendHandle;
  variant?: 'inbox' | 'settings';
}) {
  const t = useT();
  const own = useLend(api);
  const handle = lend ?? own;
  const [open, setOpen] = useState(false);
  if (!handle.enabled || !handle.state) return null;
  const asks = recentAsks(handle.state, handle.now);
  return (
    <div className="lend-entry" data-lend-entry={variant}>
      <button type="button" className="lend-btn" onClick={() => setOpen(true)}>
        {t('lend.request.title')}
      </button>
      {asks.length > 0 && (
        <ul className="lend-asks" aria-label={t('lend.request.yours')}>
          {asks.map((r) => (
            <li key={r.id}>
              <span>{askWords(r, handle.state)}</span>
              <span className="lend-status" data-state={r.state}>
                {askStatus(r)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {open && <RequestSheet api={api} team={team} lend={handle} onClose={() => setOpen(false)} />}
    </div>
  );
}

function RequestSheet({ api, team, lend, onClose }: { api: LendApi; team: TeamApi; lend: LendHandle; onClose: () => void }) {
  const t = useT();
  const [members, setMembers] = useState<MemberView[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [from, setFrom] = useState('');
  const [agent, setAgent] = useState('');
  const [secs, setSecs] = useState(DEFAULT_SECS);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentId, setSentId] = useState<string | null>(null);
  const state = lend.state!;

  useEffect(() => {
    let alive = true;
    team
      .configGet()
      .then((v) => alive && setMembers(v.members))
      .catch(() => alive && setLoadError(true));
    return () => {
      alive = false;
    };
  }, [team]);

  const { mine, others } = useMemo(() => sourcesOf(members ?? []), [members]);
  const all = [...mine, ...others];
  const agents = offerable(state.drivers);
  const picked = all.find((s) => s.value === (from || all[0]?.value));
  const agentId = agent || agents[0]?.agent_id || '';
  const forOther = picked ? !picked.mine : true;
  const problem = durationProblem(secs, forOther);
  const canAsk = !!picked && !!agentId && !problem && !busy;

  const ask = async () => {
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.request(picked.memberId, picked.deviceId, agentId, secs, reason.trim());
      setSentId(r.id);
      lend.refresh();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  if (sentId) {
    // The status page: it follows the request as the other side answers.
    const live = state.requests_out.find((r) => r.id === sentId);
    const status = live?.state ?? 'open';
    return (
      <LendSheet title={t('lend.request.sent')} labelledBy="lend-ask-t" onClose={onClose}>
        <p>
          {picked?.label} · {agentLabel(state, agentId)} · {durationWords(secs)}
        </p>
        <p role="status" aria-live="polite">
          <span className="lend-status" data-state={status}>
            {askStatus({ state: status })}
          </span>
        </p>
        <p className="lend-note">
          {status === 'accepted'
            ? t('lend.request.readyNote')
            : status === 'declined'
              ? t('lend.request.declinedNote')
              : t('lend.request.openNote')}
        </p>
        <div className="lend-actions">
          <button type="button" className="lend-btn is-primary" onClick={onClose}>
            {t('lend.request.done')}
          </button>
        </div>
      </LendSheet>
    );
  }

  return (
    <LendSheet title={t('lend.request.title')} labelledBy="lend-ask-t" onClose={busy ? undefined : onClose}>
      {loadError || (members && all.length === 0) ? (
        <p className="lend-note">{t('lend.request.nobody')}</p>
      ) : (
        <label className="lend-field">
          <span>{t('lend.request.ask')}</span>
          <select aria-label={t('lend.request.ask')} value={picked?.value ?? ''} onChange={(e) => setFrom(e.target.value)} disabled={!members}>
            {mine.length > 0 && (
              <optgroup label={t('lend.who.myPcs')}>
                {mine.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </optgroup>
            )}
            {others.length > 0 && (
              <optgroup label={t('lend.who.teammates')}>
                {others.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
      )}
      <label className="lend-field">
        <span>{t('lend.request.agent')}</span>
        <select aria-label={t('lend.request.agent')} value={agentId} onChange={(e) => setAgent(e.target.value)}>
          {agents.map((d) => (
            <option key={d.agent_id} value={d.agent_id}>
              {d.label}
              {d.support === 'lab' ? ` · ${supportTag('lab')}` : ''}
            </option>
          ))}
          {comingSoonAgents(state.drivers).map((c) => (
            <option key={c.agent_id} value={`soon:${c.agent_id}`} disabled>
              {comingSoonText(c.label)}
            </option>
          ))}
        </select>
      </label>
      {state.drivers.find((d) => d.agent_id === agentId)?.account_note && (
        <p className="lend-note" role="note">
          {state.drivers.find((d) => d.agent_id === agentId)?.account_note}
        </p>
      )}
      <DurationField secs={secs} onChange={setSecs} forOther={forOther} />
      <label className="lend-field">
        <span>{t('lend.request.why')}</span>
        <textarea aria-label={t('lend.request.whyAria')} value={reason} maxLength={MAX_REASON} rows={2} onChange={(e) => setReason(e.target.value)} />
        <span className="lend-count">
          {reason.length} / {MAX_REASON}
        </span>
      </label>
      {forOther && picked && <p className="lend-note">{t('lend.request.decides', { name: picked.label })}</p>}
      {error && (
        <p className="lend-error" role="alert">
          {error}
        </p>
      )}
      <div className="lend-actions">
        <button type="button" className="lend-btn is-plain" onClick={onClose} disabled={busy}>
          {t('lend.cancel')}
        </button>
        <button type="button" className="lend-btn is-primary" disabled={!canAsk} onClick={() => void ask()}>
          {t('lend.request.ask')}
        </button>
      </div>
    </LendSheet>
  );
}
