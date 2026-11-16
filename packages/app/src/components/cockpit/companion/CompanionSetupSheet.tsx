// "Make your companion" (SPEC section 1, the five steps): a face, a name, an agent, how it talks, and where it lives.
// The agent step reads `companion_agents`; an agent that cannot take messages is shown with its reason and cannot be
// picked. One scroll, one button: "Wake up {name}".
import { useEffect, useState } from 'react';
import type { AccentId, AvatarId, CompanionAgentOption, CompanionPersona, CompanionTransport, CompanionView } from '../../../lib/companion';
import { t, useT } from '../../../i18n';
import { shipApi, type ShipApi } from '../../../lib/ship-api';
import { useAgentRegistry } from '../../../lib/agentRegistry';
import { chatAllowedFor } from '../../../lib/mobile-pane-view';
import { Avatar } from '../../companion/Avatar';
import { AVATARS } from '../../companion/avatars';
import { Sheet } from '../Sheet';
import { ACCENTS, MAX_AWAKE_COMPANIONS, PERSONA_OPTIONS, isValidName, ownFolderIn, plainError } from './model';
import '../../../styles/cockpit-companion.css';

const FACES = Object.keys(AVATARS) as AvatarId[];
// Face tiles: the face is drawn this wide (px) so it fills the tile.
const FACE_PX = 40;
const DEFAULT_PERSONA: Exclude<CompanionPersona, 'custom'> = 'cheerful';
// The fresh start (SPEC section 4) happens at 04:00 unless the person changes it later.
const DEFAULT_NAP = { h: 4, m: 0 };

export function CompanionSetupSheet({
  transport,
  ship = shipApi,
  companions = [],
  onClose,
  onCreated,
}: {
  transport: CompanionTransport;
  /** The companions that already exist: "Start from" can copy how one of them talks. */
  companions?: CompanionView[];
  ship?: Pick<ShipApi, 'pickFolder'>;
  onClose: () => void;
  /** `note`: a short sentence when the new companion was made but one part did not work. */
  onCreated: (view: CompanionView, note?: string) => void;
}) {
  const t = useT();
  const [accent, setAccent] = useState<AccentId>('potato');
  // Copy how this companion talks (its "Who it is" text, never its notes). Null: start empty.
  const [copyFrom, setCopyFrom] = useState<string | null>(null);
  const [agents, setAgents] = useState<CompanionAgentOption[] | null>(null);
  const [agentType, setAgentType] = useState<string | null>(null);
  const [avatar, setAvatar] = useState<AvatarId>('mochi');
  const [name, setName] = useState(AVATARS.mochi.name);
  // Once the person types a name, changing the face keeps their name.
  const [nameTouched, setNameTouched] = useState(false);
  const [persona, setPersona] = useState<Exclude<CompanionPersona, 'custom'>>(DEFAULT_PERSONA);
  // The folder the person picked to hold it. Null: the default folder, which Potato Workspace makes. The home itself is
  // always a folder of its own inside the picked one (`<picked>\<id>`), never the picked folder: agents that work
  // anywhere below a home read the companion's brief, so a home must not hold other projects.
  const [parent, setParent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    transport
      .agents()
      .then((list) => {
        if (!live) return;
        setAgents(list);
        setAgentType((cur) => cur ?? list.find((a) => a.ok)?.id ?? null);
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : 'Could not read the agents.');
      });
    return () => {
      live = false;
    };
  }, [transport]);

  // A plain shell (kind `shell` in the agent registry) is no agent to chat with: it is not listed at all.
  const listing = useAgentRegistry();
  const shown = agents?.filter((a) => chatAllowedFor(listing, a.id)) ?? null;
  const chosen = agents?.find((a) => a.id === agentType) ?? null;
  const valid = isValidName(name) && !!chosen?.ok;
  // What the draft sends. Empty means the default folder.
  const folder = parent ? ownFolderIn(parent, name.trim() || 'companion') : '';

  const pickFace = (id: AvatarId) => {
    setAvatar(id);
    if (!nameTouched) setName(AVATARS[id].name);
  };

  const changeFolder = async () => {
    setError(null);
    try {
      const picked = await ship.pickFolder();
      if (picked) setParent(picked.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open the folder picker.');
    }
  };

  const create = async () => {
    if (!valid || !agentType) return;
    setBusy(true);
    setError(null);
    try {
      const view = await transport.create({
        name: name.trim(),
        avatar,
        accent,
        persona,
        agentType,
        folder,
        autoStart: true,
        memoryReview: true,
        napAt: DEFAULT_NAP,
        checkins: [],
      });
      const source = companions.find((c) => c.id === copyFrom);
      let note: string | undefined;
      if (source) {
        try {
          const soul = await transport.memory(source.id);
          await transport.saveMemory(view.id, 'soul', soul.soul);
        } catch {
          note = t('companions.setup.copyFailed', { name: source.name });
        }
      }
      onCreated(view, note);
    } catch (err) {
      setError(err instanceof Error ? plainError(err.message) : 'Could not make the companion.');
    } finally {
      setBusy(false);
    }
  };

  const who = name.trim() || 'it';
  return (
    <Sheet onClose={busy ? undefined : onClose} labelledBy="ck-companion-setup-title" className="ck-companion-sheet ck-companion-setup">
      <h2 className="ck-section" id="ck-companion-setup-title">
        {companions.length > 0 ? t('companions.setup.another') : 'Make your companion'}
      </h2>
      <p className="ck-sub">{t('companion.setup.lead')}</p>

      <fieldset className="ck-companion-step">
        <legend className="ck-caption">1. Pick a face</legend>
        <div className="ck-companion-faces" role="radiogroup" aria-label="Pick a face">
          {FACES.map((id) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={avatar === id}
              className={`ck-companion-face-pick${avatar === id ? ' is-picked' : ''}`}
              onClick={() => pickFace(id)}
              title={AVATARS[id].name}
            >
              <Avatar id={id} size={FACE_PX} state="idle" name={AVATARS[id].name} />
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="ck-companion-step">
        <legend className="ck-caption">{t('companions.setup.colour')}</legend>
        <div className="ck-companion-swatches" role="radiogroup" aria-label={t('companions.setup.colour')}>
          {ACCENTS.map((id) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={accent === id}
              data-accent={id}
              className={`ck-companion-swatch${accent === id ? ' is-picked' : ''}`}
              onClick={() => setAccent(id)}
              title={t(`companions.accent.${id}`)}
              aria-label={t(`companions.accent.${id}`)}
            />
          ))}
        </div>
      </fieldset>

      <label className="ck-companion-step ck-companion-field">
        <span className="ck-caption">2. Give it a name</span>
        <input
          className="ck-companion-input"
          value={name}
          maxLength={24}
          onChange={(e) => {
            setNameTouched(true);
            setName(e.target.value);
          }}
        />
      </label>

      <fieldset className="ck-companion-step">
        <legend className="ck-caption">3. Which agent should it use?</legend>
        <p className="ck-sub ck-companion-hint">It uses your own plan. No extra cost.</p>
        {agents === null && !error && <p className="ck-sub">Looking for agents…</p>}
        {shown?.length === 0 && <p className="ck-sub">No agents yet. Set up an agent first.</p>}
        <div className="ck-companion-agents" role="radiogroup" aria-label="Which agent should it use?">
          {shown?.map((a) => (
            <button
              key={a.id}
              type="button"
              role="radio"
              aria-checked={agentType === a.id}
              disabled={!a.ok}
              className={`ck-companion-agent${agentType === a.id ? ' is-picked' : ''}`}
              onClick={() => setAgentType(a.id)}
            >
              <span>{a.label}</span>
              {!a.ok && a.reason && <span className="ck-sub ck-companion-reason">{a.reason}</span>}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="ck-companion-step">
        <legend className="ck-caption">4. How should it talk?</legend>
        <div className="ck-companion-chips">
          {PERSONA_OPTIONS.map((o) => (
            <button
              key={o.id}
              type="button"
              aria-pressed={persona === o.id}
              className={`ck-companion-chip${persona === o.id ? ' is-picked' : ''}`}
              onClick={() => setPersona(o.id)}
            >
              {o.label}
            </button>
          ))}
        </div>
      </fieldset>

      {companions.length > 0 && (
        <fieldset className="ck-companion-step">
          <legend className="ck-caption">{t('companions.setup.startFrom')}</legend>
          <div className="ck-companion-chips">
            <button type="button" aria-pressed={copyFrom === null} className={`ck-companion-chip${copyFrom === null ? ' is-picked' : ''}`} onClick={() => setCopyFrom(null)}>
              {t('companions.setup.startEmpty')}
            </button>
            {companions.map((c) => (
              <button
                key={c.id}
                type="button"
                aria-pressed={copyFrom === c.id}
                className={`ck-companion-chip${copyFrom === c.id ? ' is-picked' : ''}`}
                onClick={() => setCopyFrom(c.id)}
              >
                {t('companions.setup.startCopy', { name: c.name })}
              </button>
            ))}
          </div>
          {copyFrom && <p className="ck-sub ck-companion-hint">{t('companions.setup.startCopyHint', { name: companions.find((c) => c.id === copyFrom)?.name ?? '' })}</p>}
          {companions.length >= MAX_AWAKE_COMPANIONS && <p className="ck-sub ck-companion-hint">{t('companions.awakeNote')}</p>}
        </fieldset>
      )}

      <fieldset className="ck-companion-step">
        <legend className="ck-caption">5. Where does it live?</legend>
        <div className="ck-companion-folder">
          <span className="ck-companion-folder-name" title={folder || undefined}>
            {folder ? folder : 'A folder of its own, made for it'}
          </span>
          <button type="button" className="ck-btn ck-btn--sm ck-btn--secondary" onClick={() => void changeFolder()} disabled={busy}>
            Change folder
          </button>
        </div>
      </fieldset>

      {error && (
        <p className="ck-memory-msg ck-memory-err" role="alert">
          {error}
        </p>
      )}
      <p className="ck-sub ck-companion-privacy">Its files stay on this computer, in {folder || 'a folder of its own that Potato Workspace makes'}. It never posts anything in public.</p>

      <div className="ck-sheet-actions">
        <button type="button" className="ck-btn ck-btn--plain" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="ck-btn ck-btn--primary" onClick={() => void create()} disabled={!valid || busy}>
          {busy ? 'Waking up…' : `Wake up ${who}`}
        </button>
      </div>
    </Sheet>
  );
}
