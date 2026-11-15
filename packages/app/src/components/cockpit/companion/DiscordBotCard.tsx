// "Discord bot" (Labs): one companion answers in Discord channels the person chose, with the person's own bot.
// The token is write-only: it lives in an uncontrolled password field, is read once on Save and cleared at once,
// and never goes into state, text, a toast or storage. After saving, the card only knows the last four characters.
// The card shows only when the transport has a bot and the PC says the Labs switch is on.
import { useEffect, useRef, useState } from 'react';
import type { CompanionTransport, DiscordAllow, DiscordBotSettings, DiscordBotState, DiscordBotStatus } from '../../../lib/companion';
import { useT } from '../../../i18n';
import { sayError } from '../../../lib/sayError';

const ID = /^\d{15,20}$/;
const splitIds = (text: string): string[] => text.split(/[\s,]+/).filter(Boolean);
const splitNames = (text: string): string[] => text.split(',').map((n) => n.trim()).filter(Boolean);

type Msg = { kind: 'ok' | 'error'; text: string } | null;

const STATE_KEY: Record<Exclude<DiscordBotState, 'online'>, string> = {
  off: 'companion.discord.state.off',
  no_token: 'companion.discord.state.no_token',
  connecting: 'companion.discord.state.connecting',
  token_rejected: 'companion.discord.state.token_rejected',
  intent_missing: 'companion.discord.state.intent_missing',
  stopped: 'companion.discord.state.stopped',
};

export function DiscordBotCard({ companionId, transport }: { companionId: string; transport: CompanionTransport }) {
  const t = useT();
  const bot = transport.discordBot;
  const [status, setStatus] = useState<DiscordBotStatus | null>(null);
  const [draft, setDraft] = useState<DiscordBotSettings | null>(null);
  const [ownersText, setOwnersText] = useState('');
  const [namesText, setNamesText] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [hasText, setHasText] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tokenMsg, setTokenMsg] = useState<Msg>(null);
  const [settingsMsg, setSettingsMsg] = useState<Msg>(null);
  const [checkMsg, setCheckMsg] = useState<Msg>(null);
  const [newGuild, setNewGuild] = useState('');
  const [newChannels, setNewChannels] = useState('');
  const [newAmbient, setNewAmbient] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const tokenRef = useRef<HTMLInputElement>(null);

  const take = (next: DiscordBotStatus) => {
    setStatus(next);
    setDraft({ ...next.settings, allow: next.settings.allow.map((a) => ({ ...a, channels: [...a.channels] })) });
    setOwnersText(next.settings.owners.join(', '));
    setNamesText(next.settings.names.join(', '));
  };

  useEffect(() => {
    if (!bot) return;
    let live = true;
    bot
      .status(companionId)
      .then((next) => {
        if (live) take(next);
      })
      .catch(() => {
        if (live) setStatus(null);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot, companionId]);

  if (!bot || !status || !status.enabled || !draft) return null;

  const fail = (err: unknown): string => sayError(err).text || t('companion.discord.failed');

  const saveToken = async () => {
    const input = tokenRef.current;
    const value = input ? input.value.trim() : '';
    if (input) input.value = '';
    setHasText(false);
    if (!value || busy) return;
    setBusy(true);
    setTokenMsg(null);
    try {
      take(await bot.setToken(companionId, value));
      setReplacing(false);
    } catch (err) {
      setTokenMsg({ kind: 'error', text: fail(err) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setTokenMsg(null);
    try {
      take(await bot.clear(companionId));
      setReplacing(false);
    } catch (err) {
      setTokenMsg({ kind: 'error', text: fail(err) });
    } finally {
      setBusy(false);
    }
  };

  const persist = async (settings: DiscordBotSettings): Promise<boolean> => {
    setBusy(true);
    setSettingsMsg(null);
    try {
      take(await bot.saveSettings(companionId, settings));
      return true;
    } catch (err) {
      setSettingsMsg({ kind: 'error', text: fail(err) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const current = (): DiscordBotSettings => ({ ...draft, owners: splitIds(ownersText), names: splitNames(namesText) });

  const toggleOn = async () => {
    if (busy || !status.set) return;
    const ok = await persist({ ...current(), on: !draft.on });
    if (ok) setSettingsMsg(null);
  };

  const saveSettings = async () => {
    if (busy) return;
    const next = current();
    if (next.owners.some((o) => !ID.test(o))) {
      setSettingsMsg({ kind: 'error', text: t('companion.discord.errOwner') });
      return;
    }
    if (await persist(next)) setSettingsMsg({ kind: 'ok', text: t('companion.discord.settingsSaved') });
  };

  const check = async () => {
    setCheckMsg(null);
    try {
      const r = await bot.test(companionId);
      setCheckMsg({ kind: r.ok ? 'ok' : 'error', text: r.message });
    } catch (err) {
      setCheckMsg({ kind: 'error', text: fail(err) });
    }
  };

  const addServer = () => {
    const guild = newGuild.trim();
    const channels = splitIds(newChannels);
    if (!ID.test(guild)) return setAddError(t('companion.discord.errServer'));
    if (channels.length === 0) return setAddError(t('companion.discord.errNoChannel'));
    if (channels.some((c) => !ID.test(c))) return setAddError(t('companion.discord.errChannel'));
    if (draft.allow.some((a) => a.guildId === guild)) return setAddError(t('companion.discord.errDuplicate'));
    const row: DiscordAllow = { guildId: guild, channels: [...new Set(channels)], ambient: newAmbient };
    setDraft({ ...draft, allow: [...draft.allow, row] });
    setNewGuild('');
    setNewChannels('');
    setNewAmbient(false);
    setAddError(null);
  };

  const setAmbient = (guildId: string, ambient: boolean) =>
    setDraft({ ...draft, allow: draft.allow.map((a) => (a.guildId === guildId ? { ...a, ambient } : a)) });

  const stateLine =
    status.state === 'online'
      ? status.botName
        ? t('companion.discord.state.online', { name: status.botName })
        : t('companion.discord.state.onlineNoName')
      : t(STATE_KEY[status.state] as 'companion.discord.state.off');
  const showTokenField = !status.set || replacing;
  const tail = status.last4 ? t('companion.discord.savedEnds', { tail: status.last4 }) : t('companion.discord.saved');
  const msg = (m: Msg) =>
    m ? (
      <p className="ck-sub ck-discord-msg" data-kind={m.kind} role={m.kind === 'error' ? 'alert' : 'status'}>
        {m.text}
      </p>
    ) : null;

  return (
    <section className="ck-companion-card ck-discord" aria-labelledby="ck-companion-discord-title">
      <h2 className="ck-companion-card-title" id="ck-companion-discord-title">
        {t('companion.discord.title')}
      </h2>
      <p className="ck-discord-state" data-state={status.state}>
        {stateLine}
      </p>

      <div className="ck-discord-block">
        <label className="ck-body-sub" htmlFor="ck-discord-token">
          {t('companion.discord.tokenLabel')}
        </label>
        {!status.storeAvailable ? (
          <>
            <p className="ck-sub">{t('companion.discord.noStore')}</p>
            <input id="ck-discord-token" className="ck-companion-input" type="password" autoComplete="off" disabled />
          </>
        ) : showTokenField ? (
          <>
            <div className="ck-discord-inline">
              <input
                id="ck-discord-token"
                ref={tokenRef}
                className="ck-companion-input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                onChange={(e) => setHasText(e.currentTarget.value.length > 0)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveToken();
                }}
              />
              <button type="button" className="ck-btn ck-btn--sm ck-btn--secondary" disabled={busy || !hasText} onClick={() => void saveToken()}>
                {busy ? t('companion.discord.saving') : t('companion.discord.save')}
              </button>
            </div>
            <p className="ck-sub">{t('companion.discord.tokenHelp')}</p>
          </>
        ) : (
          <div className="ck-companion-meta">
            <span>{tail}</span>
            <span className="ck-companion-meta-actions">
              <button type="button" className="ck-btn ck-btn--sm ck-btn--secondary" disabled={busy} onClick={() => setReplacing(true)}>
                {t('companion.discord.replace')}
              </button>
              <button type="button" className="ck-btn ck-btn--sm ck-btn--secondary" disabled={busy} onClick={() => void remove()}>
                {t('companion.discord.remove')}
              </button>
            </span>
          </div>
        )}
        {msg(tokenMsg)}
      </div>

      <div className="ck-companion-push">
        <span className="ck-companion-push-text">
          <span id="ck-discord-on-label">{t('companion.discord.onLabel')}</span>
          {!status.set && <span className="ck-sub">{t('companion.discord.onHint')}</span>}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={draft.on && status.set}
          aria-labelledby="ck-discord-on-label"
          className="ck-switch"
          disabled={busy || !status.set}
          onClick={() => void toggleOn()}
        >
          <span className="ck-switch-knob" />
        </button>
      </div>

      <div className="ck-discord-block">
        <h3 className="ck-body-sub">{t('companion.discord.allowTitle')}</h3>
        {draft.allow.length === 0 ? (
          <p className="ck-sub">{t('companion.discord.allowEmpty')}</p>
        ) : (
          <ul className="ck-companion-list">
            {draft.allow.map((a) => (
              <li className="ck-discord-allow" key={a.guildId} data-testid="discord-allow-row">
                <span className="ck-mono ck-discord-ids">{t('companion.discord.rowLine', { guild: a.guildId, channels: a.channels.join(', ') })}</span>
                <label className="ck-discord-check">
                  <input type="checkbox" checked={a.ambient} onChange={(e) => setAmbient(a.guildId, e.currentTarget.checked)} />
                  <span>{t('companion.discord.ambient')}</span>
                </label>
                <button
                  type="button"
                  className="ck-btn ck-btn--sm ck-btn--secondary"
                  aria-label={t('companion.discord.removeServer', { guild: a.guildId })}
                  onClick={() => setDraft({ ...draft, allow: draft.allow.filter((x) => x.guildId !== a.guildId) })}
                >
                  {t('companion.discord.remove')}
                </button>
              </li>
            ))}
          </ul>
        )}
        <input
          className="ck-companion-input"
          inputMode="numeric"
          aria-label={t('companion.discord.serverId')}
          placeholder={t('companion.discord.serverId')}
          value={newGuild}
          onChange={(e) => setNewGuild(e.currentTarget.value)}
        />
        <input
          className="ck-companion-input"
          aria-label={t('companion.discord.channelIds')}
          placeholder={t('companion.discord.channelIds')}
          value={newChannels}
          onChange={(e) => setNewChannels(e.currentTarget.value)}
        />
        <label className="ck-discord-check">
          <input type="checkbox" checked={newAmbient} onChange={(e) => setNewAmbient(e.currentTarget.checked)} />
          <span>{t('companion.discord.ambient')}</span>
        </label>
        <p className="ck-sub">{t('companion.discord.channelsHelp')}</p>
        {addError && (
          <p className="ck-sub ck-discord-msg" data-kind="error" role="alert">
            {addError}
          </p>
        )}
        <button type="button" className="ck-btn ck-btn--sm ck-btn--secondary ck-companion-add" onClick={addServer}>
          {t('companion.discord.addServer')}
        </button>
      </div>

      <div className="ck-discord-block">
        <label className="ck-body-sub" htmlFor="ck-discord-owners">
          {t('companion.discord.owners')}
        </label>
        <input id="ck-discord-owners" className="ck-companion-input" inputMode="numeric" value={ownersText} onChange={(e) => setOwnersText(e.currentTarget.value)} />
        <p className="ck-sub">{t('companion.discord.ownersHelp')}</p>
      </div>

      <div className="ck-discord-block">
        <label className="ck-body-sub" htmlFor="ck-discord-dms">
          {t('companion.discord.dms')}
        </label>
        <select id="ck-discord-dms" className="ck-companion-input" value={draft.dms} onChange={(e) => setDraft({ ...draft, dms: e.currentTarget.value === 'off' ? 'off' : 'owners' })}>
          <option value="owners">{t('companion.discord.dmsOwners')}</option>
          <option value="off">{t('companion.discord.dmsOff')}</option>
        </select>
      </div>

      <div className="ck-discord-block">
        <label className="ck-body-sub" htmlFor="ck-discord-names">
          {t('companion.discord.names')}
        </label>
        <input id="ck-discord-names" className="ck-companion-input" value={namesText} onChange={(e) => setNamesText(e.currentTarget.value)} />
        <p className="ck-sub">{t('companion.discord.namesHelp')}</p>
      </div>

      <div className="ck-discord-block">
        <label className="ck-body-sub" htmlFor="ck-discord-gate">
          {t('companion.discord.gate')}
        </label>
        <select id="ck-discord-gate" className="ck-companion-input" value={draft.gate} onChange={(e) => setDraft({ ...draft, gate: e.currentTarget.value === 'llm' ? 'llm' : 'heuristic' })}>
          <option value="heuristic">{t('companion.discord.gateHeuristic')}</option>
          <option value="llm">{t('companion.discord.gateLlm')}</option>
        </select>
        <p className="ck-sub">{t('companion.discord.gateHelp')}</p>
      </div>

      <div className="ck-discord-budget">
        <span>{t('companion.discord.budgetBefore')}</span>
        <input
          className="ck-companion-input ck-discord-num"
          type="number"
          min={0}
          aria-label={t('companion.discord.budgetCount')}
          value={draft.budget.count}
          onChange={(e) => setDraft({ ...draft, budget: { ...draft.budget, count: Math.max(0, Math.floor(Number(e.currentTarget.value) || 0)) } })}
        />
        <span>{t('companion.discord.budgetMid')}</span>
        <input
          className="ck-companion-input ck-discord-num"
          type="number"
          min={1}
          aria-label={t('companion.discord.budgetMinutes')}
          value={draft.budget.minutes}
          onChange={(e) => setDraft({ ...draft, budget: { ...draft.budget, minutes: Math.max(1, Math.floor(Number(e.currentTarget.value) || 1)) } })}
        />
        <span>{t('companion.discord.budgetAfter')}</span>
      </div>

      <p className="ck-sub">{t('companion.discord.usage', { used: status.callsToday, cap: status.callsCap })}</p>

      <div className="ck-companion-meta-actions">
        <button type="button" className="ck-btn ck-btn--sm ck-btn--secondary" disabled={busy} onClick={() => void saveSettings()}>
          {t('companion.discord.saveSettings')}
        </button>
        <button type="button" className="ck-btn ck-btn--sm ck-btn--secondary" onClick={() => void check()}>
          {t('companion.discord.check')}
        </button>
      </div>
      {msg(settingsMsg)}
      {msg(checkMsg)}

      <p className="ck-sub">{t('companion.discord.safety')}</p>
    </section>
  );
}
