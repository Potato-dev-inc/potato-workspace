// The short screens of the welcome: Done, and the two it links to (Use your phone, Add skills to your agents).
import { useEffect, useRef, useState } from 'react';
import type { Settings } from '@potato-workspace/shared';
import { agentPackApi, groupAgents, visibleRows, type AgentPackApi } from '../../lib/agent-pack';
import type { loadSettings, patchSettings } from '../../lib/settings';
import { parseDevServerPort } from '../../lib/public-bridge-url';
import { DotSpinner } from '../cockpit/DotSpinner';
import { MobilePairingPanel } from '../MobilePairingPanel';
import { PackSheet } from '../settings/pack/AgentPackGroup';
import { useT } from '../../i18n';
import { T } from './copy';
import { isSimpleLook, LOOKS, type Look, type MoreId } from './model';

export function StepPhone({ load, patch }: { load: typeof loadSettings; patch: typeof patchSettings }) {
  useT();
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => {
    let alive = true;
    load()
      .then((s) => alive && setSettings(s))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [load]);
  const save = (next: Partial<Settings>) => {
    setSettings((s) => (s ? { ...s, ...next } : s));
    void patch(next as never).catch(() => undefined);
  };
  return (
    <section className="fr-step" aria-labelledby="fr-phone-t">
            <h1 className="ck-title" id="fr-phone-t">{T.phoneTitle}</h1>
      <p className="fr-lead">{T.phoneLead}</p>
      <p className="fr-hint">{T.phoneNote}</p>
      {settings && (
        <div className="settings fr-settings-scope">
          <MobilePairingPanel
            compact
            publicPwaUrl={settings.public_pwa_url ?? ''}
            devServerPort={parseDevServerPort(settings.dev_server_port)}
            onPublicPwaUrlChange={(value) => save({ public_pwa_url: value.trim() || undefined })}
            onDevServerPortChange={(port) => save({ dev_server_port: port })}
          />
        </div>
      )}
    </section>
  );
}

/** Which agents the pack would reach, as the Settings group says it. */
export function useFound(api: AgentPackApi): string[] | null {
  const [found, setFound] = useState<string[] | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .preview()
      .then((r) => alive && setFound(visibleRows(groupAgents(r.agents)).filter((x) => x.installed).map((x) => x.labels.join(', '))))
      .catch(() => alive && setFound([]));
    return () => {
      alive = false;
    };
  }, [api]);
  return found;
}

export function StepPack({ api = agentPackApi }: { api?: AgentPackApi }) {
  useT();
  const found = useFound(api);
  const [reviewing, setReviewing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <section className="fr-step" aria-labelledby="fr-pack-t">
            <h1 className="ck-title" id="fr-pack-t">{T.packTitle}</h1>
      <p className="fr-lead">{T.packLead}</p>
      <div className="fr-card">
        <p className="fr-card-line" data-testid="pack-found">{found === null ? T.looking : T.packFound(found)}</p>
        {notice && <p className="fr-hint" role="status">{notice}</p>}
        <div className="fr-actions">
          <button type="button" className="ck-btn ck-btn--secondary" onClick={() => setReviewing(true)}>
            {T.packReview}
          </button>
        </div>
      </div>
      {reviewing && (
        <div className="settings fr-settings-scope">
          <PackSheet
            api={api}
            onClose={() => setReviewing(false)}
            onDone={(text) => {
              setReviewing(false);
              setNotice(text);
            }}
          />
        </div>
      )}
    </section>
  );
}

/** `packDone`: step 2 already added Potato Workspace and its skills, so that row shows as done. */
/**
 * "How do you work?": three radios. Each is named by its label and described by its hint; the arrow keys move
 * between them and Tab leaves the group, as for any radio group.
 */
export function LookPicker({ look, onLook }: { look: Look | null; onLook: (look: Look) => void }) {
  useT();
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const stop = look ?? LOOKS[0];
  const move = (from: number, by: number) => {
    const next = LOOKS[(from + by + LOOKS.length) % LOOKS.length];
    refs.current[next]?.focus();
    onLook(next);
  };
  return (
    <div className="fr-look">
      <h2 className="fr-cap" id="fr-how">{T.doneLookTitle}</h2>
      <div className="fr-looklist" role="radiogroup" aria-labelledby="fr-how">
        {LOOKS.map((id, i) => (
          <button
            key={id}
            ref={(el) => {
              refs.current[id] = el;
            }}
            type="button"
            role="radio"
            aria-checked={look === id}
            aria-describedby={`fr-look-${id}-hint`}
            tabIndex={stop === id ? 0 : -1}
            className="fr-lookopt"
            onClick={() => onLook(id)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
                e.preventDefault();
                move(i, 1);
              } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
                e.preventDefault();
                move(i, -1);
              }
            }}
          >
            <span className="fr-lookname">{T.looks[id].label}</span>
            <span className="fr-hint" id={`fr-look-${id}-hint`}>{T.looks[id].hint}</span>
          </button>
        ))}
      </div>
      {look !== null && (
        <p className="fr-hint" role="status" data-testid="look-note">
          {isSimpleLook(look) ? T.noteSimple : T.noteCode}
        </p>
      )}
    </div>
  );
}

export function StepDone({
  onMore,
  packDone = false,
  look,
  onLook,
}: {
  onMore: (id: MoreId) => void;
  packDone?: boolean;
  look: Look | null;
  onLook: (look: Look) => void;
}) {
  useT();
  const tips = [
    { term: T.tipKeys, body: T.tipKeysBody, kbd: true },
    { term: T.tipInbox, body: T.tipInboxBody, kbd: false },
    { term: T.tipHistory, body: T.tipHistoryBody, kbd: false },
  ];
  return (
    <section className="fr-step" aria-labelledby="fr-done-t">
      <div className="fr-hero" aria-hidden="true">
        <DotSpinner status="exited" size={5} />
      </div>
      <h1 className="ck-title" id="fr-done-t">{T.doneTitle}</h1>
      <p className="fr-lead">{T.doneLead}</p>
      <ol className="fr-tips">
        {tips.map((tip, i) => (
          <li key={tip.term} className="fr-tipr">
            <span className="ck-doto fr-tipnum" aria-hidden="true">{String(i + 1).padStart(2, '0')}</span>
            <span className="fr-tipmain">
              {tip.kbd ? <kbd className="fr-kbd">{tip.term}</kbd> : <strong>{tip.term}</strong>}
              <span className="fr-tipbody">{tip.body}</span>
            </span>
          </li>
        ))}
      </ol>
      <LookPicker look={look} onLook={onLook} />
      <h2 className="fr-cap">{T.moreTitle}</h2>
      <ul className="fr-agentlist" data-testid="more-links">
        {(
          [
            { id: 'phone', label: T.morePhone, body: T.morePhoneBody, done: false },
            { id: 'pack', label: T.morePack, body: packDone ? T.morePackDone : T.morePackBody, done: packDone },
          ] as const
        ).map((m) => (
          <li key={m.id} className="fr-more" data-done={m.done ? 'true' : undefined}>
            <span className="fr-more-text">
              <span className="fr-more-title">
                {m.done && <DotSpinner status="exited" size={3} />}
                {m.label}
              </span>
              <span className="fr-more-body">{m.body}</span>
            </span>
            {!m.done && (
              <button type="button" className="ck-btn ck-btn--secondary ck-btn--sm" onClick={() => onMore(m.id)}>
                {T.moreOpen}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
