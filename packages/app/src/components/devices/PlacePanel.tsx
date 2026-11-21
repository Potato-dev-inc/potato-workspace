// The body of New agent while a Linux distro of this PC, or an SSH machine, is picked in "Where": an agent, a folder, and one
// button. A terminal opens there. (A paired device gets the phone-style new chat instead; chats are not offered over SSH.)
// What the person typed is only handed to the command layer, which checks every part itself.
import { useState, type ReactNode } from 'react';
import { useT } from '../../i18n';
import { errorSentence } from '../../lib/sayError';
import '../../styles/devices.css';

export interface PlaceAgent {
  id: string;
  label: string;
}

export interface PlacePanelProps {
  testId: string;
  /** Drawn first (the desktop's Where pill). */
  leading?: ReactNode;
  agents: PlaceAgent[];
  /** Said when there is nothing to start. */
  noneText: string;
  /** Short lines above the form, one paragraph each. */
  notes?: string[];
  folderLabel: string;
  folderPlaceholder: string;
  folderHelp?: string;
  startLabel: string;
  /** Starts it; resolves to the pane id. A rejection is shown as one plain sentence. */
  onStart: (agent: string, folder: string | undefined) => Promise<string>;
  onStarted: (paneId: string) => void;
  /** Put in the folder box at first (the project this panel was opened for). */
  initialFolder?: string;
}

export function PlacePanel(p: PlacePanelProps) {
  const t = useT();
  const [picked, setPicked] = useState<string | null>(null);
  const [folder, setFolder] = useState(p.initialFolder ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const agent = p.agents.find((a) => a.id === picked)?.id ?? p.agents[0]?.id ?? null;
  const start = () => {
    if (!agent) return;
    setBusy(true);
    setError(null);
    p.onStart(agent, folder.trim() || undefined).then(
      (paneId) => {
        setBusy(false);
        p.onStarted(paneId);
      },
      (e: unknown) => {
        setError(errorSentence(e));
        setBusy(false);
      },
    );
  };
  return (
    <div className="dev-place" data-testid={p.testId}>
      {p.leading}
      {p.notes?.map((n) => (
        <p key={n} className="dev-note">
          {n}
        </p>
      ))}
      {p.agents.length === 0 ? (
        <p className="dev-note" data-testid="place-none">
          {p.noneText}
        </p>
      ) : (
        <>
          <div className="dev-field">
            <span>{t('devices.place.agentLabel')}</span>
            <div className="dev-tabs" role="radiogroup" aria-label={t('devices.place.agentLabel')}>
              {p.agents.map((a) => (
                <button key={a.id} type="button" role="radio" aria-checked={a.id === agent} className={`dev-tab${a.id === agent ? ' is-on' : ''}`} data-testid={`place-agent-${a.id}`} onClick={() => setPicked(a.id)}>
                  {a.label}
                </button>
              ))}
            </div>
          </div>
          <label className="dev-field">
            <span>{p.folderLabel}</span>
            <input type="text" value={folder} placeholder={p.folderPlaceholder} spellCheck={false} onChange={(e) => setFolder(e.target.value)} data-testid="place-folder" />
            {p.folderHelp && <small className="dev-note">{p.folderHelp}</small>}
          </label>
          {error && (
            <p className="dev-error" role="alert" data-testid="place-error">
              {error}
            </p>
          )}
          <div className="dev-actions">
            <button type="button" className="dev-btn is-primary" disabled={busy || !agent} onClick={start} data-testid="place-start">
              {busy ? t('devices.place.starting') : p.startLabel}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
