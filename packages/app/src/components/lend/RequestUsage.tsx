import { useEffect, useMemo, useState } from 'react';
import { t, useT } from '../../i18n';
import { teamApi, type MemberView, type TeamApi } from '../../lib/team';
import { devicesApi, type Device, type DevicesApi } from '../../lib/devices';
import { useDevices } from '../devices/useDevices';
import { agentLabel, cleanName, comingSoonAgents, comingSoonText, DEFAULT_SECS, durationProblem, durationWords, errText, lendApi, MAX_REASON, offerable, supportTag, type LendApi, type LendRequest, type LendState, type Offer, type OffersResult } from '../../lib/lend';
import { requestNewAgent } from '../../lib/newAgentRequest';
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
  /** One of my own paired PCs on the device link (no Team needed): its node. */
  node?: string;
}

/** My other computers first ("My PCs"), then the teammates. A member's devices come from the roster. */
export function sourcesOf(members: readonly MemberView[], devices: readonly Device[] = []): { mine: Source[]; others: Source[] } {
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
  // My other PCs are the Devices list: the ones that let me borrow come first. A team roster PC with the same name is the same PC.
  const names = new Set(devices.map((d) => d.name.toLowerCase()));
  const fromTeam = mine.filter((s) => !names.has(s.label.toLowerCase()));
  const fromDevices: Source[] = devices.filter((d) => d.lets_lend).map((d) => ({ value: `node:${d.node}`, label: d.name, memberId: '', deviceId: null, mine: true, node: d.node }));
  return { mine: [...fromDevices, ...fromTeam], others };
}

/** Paired PCs that do not let borrowing happen yet: each gets one plain line. */
export const waitingDevices = (devices: readonly Device[]): Device[] => devices.filter((d) => !d.lets_lend);

const NO_DEVICES: Device[] = [];

/** Waiting / Ready / Said no. */
export const askStatus = (r: Pick<LendRequest, 'state'>): string => (r.state === 'open' ? t('lend.ask.waiting') : r.state === 'accepted' ? t('lend.ask.ready') : t('lend.ask.saidNo'));

const askWords = (r: LendRequest, state: LendState | null): string => {
  const profile = cleanName(r.profile_name);
  const parts = [r.member_name || t('lend.teammate'), ...(profile ? [profile] : []), agentLabel(state, r.agent_id), durationWords(r.secs)];
  return parts.join(' · ');
};

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
  devices,
  lend,
  variant = 'inbox',
}: {
  api?: LendApi;
  team?: TeamApi;
  devices?: DevicesApi;
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
      {open && <RequestSheet api={api} team={team} devices={devices} lend={handle} onClose={() => setOpen(false)} />}
    </div>
  );
}

function RequestSheet({ api, team, devices, lend, onClose }: { api: LendApi; team: TeamApi; devices?: DevicesApi; lend: LendHandle; onClose: () => void }) {
  const t = useT();
  const deviceList = useDevices(devices ?? devicesApi);
  const [members, setMembers] = useState<MemberView[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [from, setFrom] = useState('');
  const [agent, setAgent] = useState('');
  const [secs, setSecs] = useState(DEFAULT_SECS);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ id: string; offer: Offer | null } | null>(null);
  // What the picked person's PC offers: null while asking, then what came back.
  const [offered, setOffered] = useState<OffersResult | null>(null);
  const [offerKey, setOfferKey] = useState('');
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

  const paired = (deviceList.enabled && deviceList.view?.devices) || NO_DEVICES;
  const { mine, others } = useMemo(() => sourcesOf(members ?? [], paired), [members, paired]);
  const waiting = waitingDevices(paired);
  const all = [...mine, ...others];
  const agents = offerable(state.drivers);
  const picked = all.find((s) => s.value === (from || all[0]?.value));
  const pickedValue = picked?.value ?? '';

  // When the person to ask is picked, ask their PC what it can lend (the answer comes in a few seconds, or not at all).
  useEffect(() => {
    if (!picked) return;
    setOfferKey('');
    // One of my own PCs on the device link: there is no offers list to ask for. I pick the agent and that PC chooses the account.
    if (picked.node) {
      setOffered({ answered: false, offers: [] });
      return;
    }
    let alive = true;
    setOffered(null);
    api
      .offers(picked.memberId, picked.deviceId)
      .then((r) => {
        if (!alive) return;
        setOffered(r);
        const first = r.offers[0];
        if (first) {
          setOfferKey(`${first.device_id}|${first.profile_id}`);
          setSecs(first.default_secs);
        }
      })
      .catch(() => alive && setOffered({ answered: false, offers: [] }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, pickedValue]);

  const offer = offered?.offers.find((o) => `${o.device_id}|${o.profile_id}` === offerKey) ?? null;
  const fallback = offered !== null && !offered.answered;
  const nothing = offered !== null && offered.answered && offered.offers.length === 0;
  const agentId = offer?.agent_id ?? (agent || agents[0]?.agent_id || '');
  const forOther = picked ? !picked.mine : true;
  const problem = durationProblem(secs, forOther) ?? (offer && secs > offer.max_secs ? t('lend.dur.mostHere', { time: durationWords(offer.max_secs) }) : null);
  const canAsk = !!picked && !problem && !busy && (offer !== null || (fallback && !!agentId));
  const askedName = picked?.label ?? '';

  const ask = async () => {
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      const r = picked.node
        ? await api.requestOwn!(picked.node, agentId, secs, reason.trim())
        : offer
        ? await api.request(picked.memberId, offer.device_id, offer.agent_id, secs, reason.trim(), offer.profile_id, offer.name)
        : await api.request(picked.memberId, picked.deviceId, agentId, secs, reason.trim());
      setSent({ id: r.id, offer });
      lend.refresh();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    // The status page: it follows the request as the other side answers.
    const live = state.requests_out.find((r) => r.id === sent.id);
    const status = live?.state ?? 'open';
    return (
      <LendSheet title={t('lend.request.sent')} labelledBy="lend-ask-t" onClose={onClose}>
        <p>
          {sent.offer
            ? t('lend.request.asked', { name: askedName, profile: cleanName(sent.offer.name), agent: agentLabel(state, sent.offer.agent_id), time: durationWords(secs) })
            : `${picked?.label} · ${agentLabel(state, agentId)} · ${durationWords(secs)}`}
        </p>
        <p role="status" aria-live="polite">
          <span className="lend-status" data-state={status}>
            {askStatus({ state: status })}
          </span>
        </p>
        <p className="lend-note">{status === 'accepted' ? t('lend.request.readyNote') : status === 'declined' ? t('lend.request.declinedNote') : t('lend.request.openNote')}</p>
        <div className="lend-actions">
          {status === 'accepted' && (
            <button
              type="button"
              className="lend-btn is-primary"
              onClick={() => {
                onClose();
                requestNewAgent();
              }}
            >
              {t('lend.startChat')}
            </button>
          )}
          <button type="button" className={status === 'accepted' ? 'lend-btn' : 'lend-btn is-primary'} onClick={onClose}>
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
      {waiting.map((d) => (
        <p key={d.node} className="lend-note" data-testid="lend-turn-on">
          {t('lend.request.turnOn', { name: d.name })}
        </p>
      ))}
      {picked && (
        <fieldset className="lend-cards" aria-label={t('lend.request.what')} data-testid="lend-offers">
          <legend className="lend-legend">{t('lend.request.what')}</legend>
          {offered === null && (
            <p className="lend-muted" role="status">
              {t('lend.request.asking', { name: askedName })}
            </p>
          )}
          {offered?.offers.map((o) => {
            const key = `${o.device_id}|${o.profile_id}`;
            return (
              <label key={key} className="lend-card" data-on={offerKey === key ? 'true' : undefined}>
                <input
                  type="radio"
                  name="lend-offer"
                  checked={offerKey === key}
                  onChange={() => {
                    setOfferKey(key);
                    setSecs(o.default_secs);
                  }}
                />
                <span className="lend-card-text">
                  <strong>{cleanName(o.name)}</strong>
                  <small>
                    {t('lend.offer.sub', { agent: agentLabel(state, o.agent_id), time: durationWords(o.max_secs), how: o.asks_first ? t('lend.asksFirst') : t('lend.offer.atOnce') })}
                  </small>
                </span>
              </label>
            );
          })}
          {nothing && <p className="lend-note">{t('lend.request.nothing', { name: askedName })}</p>}
          {fallback && (
            <>
              {!picked.node && (
                <p className="lend-note" role="note" data-testid="lend-no-answer">
                  {t('lend.request.noAnswer', { name: askedName })}
                </p>
              )}
              <label className="lend-field">
                <span>{t('lend.request.agent')}</span>
                <select aria-label={t('lend.request.agent')} value={agentId} onChange={(e) => setAgent(e.target.value)}>
                  {agents.map((d) => (
                    <option key={d.agent_id} value={d.agent_id}>
                      {d.label}
                    </option>
                  ))}
                  {comingSoonAgents(state.drivers).map((c) => (
                    <option key={c.agent_id} value={`soon:${c.agent_id}`} disabled>
                      {comingSoonText(c.label)}
                    </option>
                  ))}
                </select>
              </label>
              {state.drivers.find((d) => d.agent_id === agentId)?.support === 'lab' && <span className="lend-tag">{supportTag('lab')}</span>}
              {state.drivers.find((d) => d.agent_id === agentId)?.account_note && (
                <p className="lend-note" role="note">
                  {state.drivers.find((d) => d.agent_id === agentId)?.account_note}
                </p>
              )}
            </>
          )}
        </fieldset>
      )}
      <DurationField secs={secs} onChange={setSecs} forOther={forOther} maxSecs={offer?.max_secs} />
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
