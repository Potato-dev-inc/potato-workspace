import { useEffect, useMemo, useState } from 'react';
import { t, useT } from '../../i18n';
import { teamApi, type MemberView, type TeamApi } from '../../lib/team';
import { devicesApi, type Device, type DevicesApi } from '../../lib/devices';
import { useDevices } from '../devices/useDevices';
import { agentLabel, cleanName, comingSoonAgents, comingSoonText, DEFAULT_SECS, durationProblem, durationWords, displayName, errText, lendApi, MAX_REASON, offerable, refusedSwitch, supportTag, type LendApi, type LendRequest, type LendState, type Offer, type OffersResult, type RefusedSwitch } from '../../lib/lend';
import { requestNewAgent } from '../../lib/newAgentRequest';
import { openDeviceAt } from '../../lib/openDevice';
import { openSettingsAt } from '../../lib/openSettingsAt';
import { DisabledReason } from '../common/DisabledReason';
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
  /** One of my paired PCs whose "Borrow my agent sign-ins" switch is off on this PC: asking still works for an account PC, but the form says where the switch is. */
  blocked?: boolean;
}

const norm = (n: string): string => n.trim().toLowerCase();

/** My other computers first ("My PCs"), then the teammates. A member's devices come from the roster. */
export function sourcesOf(members: readonly MemberView[], devices: readonly Device[] = [], selfNames: readonly string[] = []): { mine: Source[]; others: Source[] } {
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
  const names = new Set(devices.map((d) => norm(d.name)));
  const self = new Set(selfNames.map(norm).filter(Boolean));
  const fromTeam = mine.filter((s) => !names.has(norm(s.label)));
  // Every paired PC is listed; one that cannot lend to me yet is marked, so the form says which switch to turn on.
  const fromDevices: Source[] = devices.map((d) => ({ value: `node:${d.node}`, label: d.name, memberId: '', deviceId: null, mine: true, node: d.node, blocked: !d.lets_lend }));
  // Each machine once: a teammate who is one of my own PCs (their name, or any computer they list, matches one of mine) is that PC; this PC is never offered to itself.
  const mineNames = new Set([...names, ...self, ...fromTeam.map((s) => norm(s.label))]);
  const memberDevices = new Map(members.map((m) => [m.id, (m.deviceList ?? []).map((d) => norm(d.name))]));
  // This PC is one of the member's computers (ids from the roster): that member is me, never a teammate.
  const hasThisPc = new Set(members.filter((m) => (m.deviceList ?? []).some((d) => d.current)).map((m) => m.id));
  const isMine = (o: Source) => hasThisPc.has(o.memberId) || mineNames.has(norm(o.label)) || (memberDevices.get(o.memberId) ?? []).some((n) => mineNames.has(n));
  return { mine: [...fromDevices, ...fromTeam], others: others.filter((o) => !isMine(o)) };
}

/** What the Ask form opens on: the first of my PCs with its switch on, else the first of my PCs (its line says where the switch is), else the first teammate. */
export function defaultSource(mine: readonly Source[], others: readonly Source[]): Source | undefined {
  return mine.find((s) => !s.blocked) ?? mine[0] ?? others[0];
}


const NO_DEVICES: Device[] = [];
/** How long a refusal line stays when nothing new arrives. */
export const REFUSAL_MS = 10_000;

/** Waiting / Ready / Said no. */
export const askStatus = (r: Pick<LendRequest, 'state'>): string => (r.state === 'open' ? t('lend.ask.waiting') : r.state === 'accepted' ? t('lend.ask.ready') : t('lend.ask.saidNo'));

/** The one name a lender goes by in this list, whichever way the ask was sent (a person's name, or their PC's). */
const askedName = (r: LendRequest): string => (r.for_other_person ? r.device_name || r.member_name || t('lend.request.myOtherPc') : displayName({ device: r.device_name, label: r.member_name }));
/** "REN (founder-dev3)" and "REN" are the same lender. */
const lenderKey = (r: LendRequest): string => (r.member_name || r.device_name).replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase();

const askWords = (r: LendRequest, state: LendState | null): string => {
  const profile = cleanName(r.profile_name);
  const parts = [askedName(r), ...(profile ? [profile] : []), agentLabel(state, r.agent_id), durationWords(r.secs)];
  return parts.join(' · ');
};

const DAY_MS = 24 * 3600_000;
/** A Ready row is only the gap between "yes" and the borrow showing up: ten minutes at most. */
const READY_MS = 10 * 60_000;

/**
 * The asks of mine still worth seeing, one row per (lender, agent) showing the newest state: waiting; Ready only for ten minutes and while no borrow of that agent has begun since (the borrow shows itself); Said no for a day (then gone, or at once with Remove). `dismissed`: ids removed by hand.
 */
export const recentAsks = (state: LendState | null, now: number, dismissed: readonly string[] = []): LendRequest[] => {
  const grants = state?.grants ?? [];
  const live = (state?.requests_out ?? [])
    .filter((r) => !dismissed.includes(r.id))
    .filter((r) => now < r.at_ms + Math.max(r.secs, 3600) * 1000)
    .filter((r) => r.state === 'open' || (now - r.at_ms < (r.state === 'accepted' ? READY_MS : DAY_MS) && (r.state !== 'accepted' || !grants.some((g) => g.direction === 'in' && g.agent_id === r.agent_id && g.started_ms >= r.at_ms - 120_000))));
  // The same lender and agent asked again (by the person, then by their PC, or once more later) is one row: the newest.
  return live.filter((r) => !live.some((o) => o !== r && lenderKey(o) === lenderKey(r) && o.agent_id === r.agent_id && o.at_ms >= r.at_ms && (o.at_ms > r.at_ms || o.id > r.id))).sort((a, b) => a.at_ms - b.at_ms).slice(-3);
};

const DISMISS_KEY = 'pm.lend.asksDismissed';
function readDismissed(): string[] {
  try {
    const v = JSON.parse(window.localStorage.getItem(DISMISS_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(-50) : [];
  } catch {
    return [];
  }
}

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
  const [dismissed, setDismissed] = useState<string[]>(readDismissed);
  const remove = (id: string) => {
    const next = [...dismissed, id].slice(-50);
    setDismissed(next);
    try {
      window.localStorage.setItem(DISMISS_KEY, JSON.stringify(next));
    } catch {
      /* the row only stays hidden until this screen closes */
    }
  };
  // With lending off this stays on screen: the one line below says which switch is off, and opens it here.
  if (!handle.known) return null;
  const asks = handle.state ? recentAsks(handle.state, handle.now, dismissed) : [];
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
              {r.state === 'declined' && (
                <button type="button" className="lend-btn is-small is-plain" onClick={() => remove(r.id)}>
                  {t('lend.ask.remove')}
                </button>
              )}
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
  if (!lend.enabled || !lend.state) {
    return (
      <LendSheet title={t('lend.request.title')} labelledBy="lend-ask-t" onClose={onClose}>
        <SwitchOffLine
          kind="thisGlobal"
          onOpen={() => {
            onClose();
            openSettingsAt('general', 'lend-labs');
          }}
        />
      </LendSheet>
    );
  }
  return <RequestForm api={api} team={team} devices={devices} lend={lend} onClose={onClose} />;
}

/**
 * One plain line: exactly which switch is off and on which PC. When the switch is on THIS PC it has the button
 * that opens it here; the other PC only ever gets a sentence (nothing is switched on there from here).
 */
function SwitchOffLine({ kind, name, onOpen, onRetry }: { kind: 'thisGlobal' | 'thisDevice' | RefusedSwitch; name?: string; onOpen?: () => void; /** The other PC's switch state is not something this PC reads: the person turns it on there and asks again. */ onRetry?: () => void }) {
  const t = useT();
  const line =
    kind === 'thisGlobal'
      ? t('lend.switch.thisGlobal')
      : kind === 'thisDevice'
        ? t('lend.switch.thisDevice', { name: name ?? '' })
        : kind === 'otherGlobal'
          ? t('lend.switch.otherGlobal', { name: name ?? '' })
          : t('lend.switch.otherDevice', { name: name ?? '' });
  return (
    <div className="lend-turn-on" data-testid="lend-switch-off" data-switch={kind} data-where={onOpen ? 'this' : 'other'}>
      <p className="lend-note">{line}</p>
      {onOpen && (
        <button type="button" className="lend-btn is-small" onClick={onOpen}>
          {t('lend.switch.open')}
        </button>
      )}
      {onRetry && (
        <button type="button" className="lend-btn is-small" data-testid="lend-switch-retry" onClick={onRetry}>
          {t('lend.signin.tryAgain')}
        </button>
      )}
    </div>
  );
}

function RequestForm({ api, team, devices, lend, onClose }: { api: LendApi; team: TeamApi; devices?: DevicesApi; lend: LendHandle; onClose: () => void }) {
  const t = useT();
  const deviceList = useDevices(devices ?? devicesApi);
  const [members, setMembers] = useState<MemberView[] | null>(null);
  const [teamName, setTeamName] = useState('');
  const [loadError, setLoadError] = useState(false);
  const [from, setFrom] = useState('');
  const [agent, setAgent] = useState('');
  const [secs, setSecs] = useState(DEFAULT_SECS);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A refused ask: the other PC said which of its switches is off. Kept apart from other errors (it is not an error of this form).
  const [refused, setRefused] = useState<{ kind: RefusedSwitch; name: string; seen: string } | null>(null);
  const [sent, setSent] = useState<{ id: string; offer: Offer | null } | null>(null);
  // What the picked person's PC offers: null while asking, then what came back.
  const [offered, setOffered] = useState<OffersResult | null>(null);
  const [offerKey, setOfferKey] = useState('');
  const state = lend.state!;

  useEffect(() => {
    let alive = true;
    team
      .configGet()
      // Team off (or never joined): its roster, if any is left over, is nobody to ask.
      // A team that is not running (removed, stopped) cannot be asked either.
      .then((v) => {
        if (!alive) return;
        setTeamName(v.name ?? '');
        setMembers(v.enabled === false || v.team === '' || v.transport === null ? [] : v.members);
      })
      .catch(() => alive && setLoadError(true));
    return () => {
      alive = false;
    };
  }, [team]);

  // The other PC's switches change while this sheet is open: read the devices again on every lend state event, and every few seconds while a switch is said to be off.
  const { refresh: refreshDevices } = deviceList;
  useEffect(() => {
    refreshDevices();
  }, [state, refreshDevices]);
  const paired = (deviceList.enabled && deviceList.view?.devices) || NO_DEVICES;
  const thisPc = deviceList.view?.name ?? '';
  const { mine, others } = useMemo(() => sourcesOf(members ?? [], paired, [thisPc, teamName]), [members, paired, thisPc, teamName]);
  const all = [...mine, ...others];
  const agents = offerable(state.drivers);
  const picked = all.find((s) => s.value === from) ?? defaultSource(mine, others);
  const pickedValue = picked?.value ?? '';
  const stillOff = refused !== null || picked?.blocked === true;
  useEffect(() => {
    if (!stillOff) return;
    const timer = window.setInterval(refreshDevices, 3000);
    return () => window.clearInterval(timer);
  }, [stillOff, refreshDevices]);
  // What this PC knows of the picked PC's switches. A refusal is only told while this stays as it was: when the other PC's switch is turned on, the line goes and Ask is open again, no reopening.
  const knownNow = JSON.stringify([picked?.blocked ?? null, state.enabled]);
  useEffect(() => {
    if (refused && refused.seen !== knownNow) setRefused(null);
  }, [refused, knownNow]);
  // The refusal is the answer to the LAST ask, not the other PC's live switch (this PC does not read that one): it goes after 10 s, and "Try again" asks at once.
  useEffect(() => {
    if (!refused) return;
    const gone = window.setTimeout(() => setRefused(null), REFUSAL_MS);
    return () => window.clearTimeout(gone);
  }, [refused]);

  // When the person to ask is picked, ask their PC what it can lend (the answer comes in a few seconds, or not at all).
  useEffect(() => {
    if (!picked) return;
    setOfferKey('');
    // A new place to ask: whatever the last ask was told about a switch there no longer applies.
    setRefused(null);
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
  const canAsk = !!picked && !refused && !problem && !busy && (offer !== null || (fallback && !!agentId));
  const askedName = picked?.label ?? '';
  // Why Ask is off, said on screen (not only on hover).
  const askReason = canAsk || busy ? null : !picked ? t('lend.request.pickFirst') : refused ? null /* the switch line below says it */ : problem ?? (offered === null ? t('lend.request.asking', { name: askedName }) : null);

  const ask = async () => {
    if (!picked) return;
    setBusy(true);
    setError(null);
    setRefused(null);
    try {
      const r = picked.node
        ? await api.requestOwn!(picked.node, agentId, secs, reason.trim())
        : offer
        ? await api.request(picked.memberId, offer.device_id, offer.agent_id, secs, reason.trim(), offer.profile_id, offer.name)
        : await api.request(picked.memberId, picked.deviceId, agentId, secs, reason.trim());
      setSent({ id: r.id, offer });
      lend.refresh();
    } catch (err) {
      // The other PC is the only side that can say one of its switches is off; say it in our words, with no button.
      const kind = picked.node ? refusedSwitch(err) : null;
      if (kind) setRefused({ kind, name: picked.label, seen: knownNow });
      else setError(errText(err));
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
      {members === null && !loadError && (
        <p className="lend-note" role="status" data-testid="lend-ask-loading">
          {t('lend.request.loading')}
        </p>
      )}
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
      {picked?.blocked && picked.node && (
        <SwitchOffLine
          kind="thisDevice"
          name={picked.label}
          onOpen={() => {
            onClose();
            openDeviceAt(picked.node!);
          }}
        />
      )}
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
      {refused && <SwitchOffLine kind={refused.kind} name={refused.name} onRetry={() => void ask()} />}
      {error && (
        <p className="lend-error" role="alert">
          {error}
        </p>
      )}
      <DisabledReason reason={askReason} />
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
