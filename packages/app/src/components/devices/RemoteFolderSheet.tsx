// "Open a folder on <PC>": the sheet behind a device group's "Add project" in the New agent project picker. It lists the projects that
// PC knows (`GET /pclink/projects`, already read by the picker); clicking one opens it at once, with no separate Open button. "Browse
// folders…" looks through the places that PC offers (`GET /pclink/browse`, Full level only: the far PC decides) and opens the folder
// you are in with its own button (`POST /pclink/projects/open`). Folders are named, never pathed: the far PC answers with names and
// opaque ids, and this side only ever sends back a root id and the names it was given.
import { useId, useState } from 'react';
import { useT } from '../../i18n';
import { atLeast, PcLinkError, type PcBrowseList, type PcBrowseRoot, type PcLinkClient, type PcProject } from '../../lib/runtime/pclink';
import { Sheet } from '../cockpit/Sheet';
import { IconFolder } from '../cockpit/Icons';
import '../../styles/chat-move.css';

type Step = { kind: 'places'; roots: PcBrowseRoot[] | null } | { kind: 'folder'; list: PcBrowseList | null; root: PcBrowseRoot };

export function RemoteFolderSheet({
  name,
  client,
  projects,
  level,
  onPick,
  onClose,
}: {
  /** The far PC's name. */
  name: string;
  client: PcLinkClient;
  /** What the far PC knows now (the group the picker already holds). */
  projects: PcProject[];
  /** What the far PC lets this PC do (`GET /pclink/me`), or null while that is not known. */
  level: 'watch' | 'answer' | 'full' | null;
  /** A folder was opened or picked: its project on the far PC. */
  onPick: (project: PcProject) => void;
  onClose: () => void;
}) {
  const t = useT();
  const titleId = useId();
  const [step, setStep] = useState<Step | null>(null);
  /** The names from the root down to where the person is. */
  const [trail, setTrail] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canBrowse = atLeast(level, 'full');

  const say = (e: unknown) => setError(e instanceof PcLinkError && e.said ? t('newAgent.dev.sheet.refused', { name, why: e.said }) : t('newAgent.dev.sheet.failed', { name }));

  const showPlaces = () => {
    setError(null);
    setTrail([]);
    setStep({ kind: 'places', roots: null });
    client.browse().then(
      (r) => setStep({ kind: 'places', roots: 'roots' in r ? r.roots : [] }),
      (e) => (setStep(null), say(e)),
    );
  };
  const enter = (root: PcBrowseRoot, names: string[]) => {
    setError(null);
    setStep({ kind: 'folder', root, list: null });
    client.browse(root.id, names.join('/')).then(
      (r) => {
        setTrail(names);
        setStep({ kind: 'folder', root, list: 'entries' in r ? r : null });
      },
      (e) => (setStep(null), say(e)),
    );
  };

  const open = async (root: PcBrowseRoot, names: string[]) => {
    setBusy(true);
    setError(null);
    try {
      onPick(await client.openFolder(root.id, names.join('/')));
    } catch (e) {
      say(e);
      setBusy(false);
    }
  };

  const inList = step === null;
  return (
    <Sheet onClose={busy ? undefined : onClose} role="dialog" labelledBy={titleId} className="ck-branch-sheet ck-move-sheet" >
      <div id={titleId} className="ck-title" data-testid="folder-sheet-title">
        {t('newAgent.dev.sheet.title', { name })}
      </div>
      {inList && (
        <>
          <p className="ck-sub">{t('newAgent.dev.sheet.lede', { name })}</p>
          <div className="ck-branch-label">{t('newAgent.dev.sheet.recent', { name })}</div>
          {projects.length === 0 && <p className="ck-sub">{t('newAgent.dev.sheet.none', { name })}</p>}
          <div className="ck-branch-list" role="menu">
            {projects.map((p) => (
              <button key={p.id} type="button" role="menuitem" className="ck-branch-row" data-testid={`folder-sheet-project-${p.id}`} disabled={busy} onClick={() => onPick(p)}>
                <IconFolder />
                <span className="ck-branch-name">{p.name}</span>
              </button>
            ))}
          </div>
          {!canBrowse && level !== null && (
            <p className="ck-sub ck-move-note" data-testid="folder-sheet-needs-full">
              {t('newAgent.dev.sheet.needsFull', { name })}
            </p>
          )}
        </>
      )}
      {step?.kind === 'places' && (
        <>
          <div className="ck-branch-label">{t('newAgent.dev.sheet.places', { name })}</div>
          {step.roots === null && <p className="ck-sub">{t('newAgent.dev.sheet.loading')}</p>}
          <div className="ck-branch-list" role="menu">
            {step.roots?.map((r) => (
              <button key={r.id} type="button" role="menuitem" className="ck-branch-row" data-testid={`folder-sheet-root-${r.id}`} onClick={() => enter(r, [])}>
                <IconFolder />
                <span className="ck-branch-name">{r.name}</span>
              </button>
            ))}
          </div>
        </>
      )}
      {step?.kind === 'folder' && (
        <>
          <div className="ck-branch-label" data-testid="folder-sheet-trail">
            {[step.root.name, ...trail].join(' / ')}
          </div>
          {step.list === null && <p className="ck-sub">{t('newAgent.dev.sheet.loading')}</p>}
          {step.list && step.list.entries.length === 0 && <p className="ck-sub">{t('newAgent.dev.sheet.empty')}</p>}
          <div className="ck-branch-list" role="menu">
            {step.list?.entries.map((e) => (
              <button key={e.name} type="button" role="menuitem" className="ck-branch-row" data-testid={`folder-sheet-dir-${e.name}`} onClick={() => enter(step.root, [...trail, e.name])}>
                <IconFolder />
                <span className="ck-branch-name">{e.name}</span>
              </button>
            ))}
          </div>
          {step.list?.truncated && <p className="ck-sub ck-move-note">{t('newAgent.dev.sheet.cut', { n: step.list.entries.length })}</p>}
        </>
      )}
      {error && (
        <p className="ck-sub ck-move-note" role="alert" data-testid="folder-sheet-error">
          {error}
        </p>
      )}
      <div className="ck-sheet-actions">
        {inList && canBrowse && (
          <button type="button" className="ck-btn ck-btn--sm ck-btn--secondary" data-testid="folder-sheet-browse" onClick={showPlaces}>
            {t('newAgent.dev.sheet.browse')}
          </button>
        )}
        {step?.kind === 'places' && (
          <button type="button" className="ck-btn ck-btn--sm ck-btn--secondary" onClick={() => setStep(null)}>
            {t('newAgent.dev.sheet.back')}
          </button>
        )}
        {step?.kind === 'folder' && (
          <button type="button" className="ck-btn ck-btn--sm ck-btn--secondary" onClick={() => (trail.length > 0 ? enter(step.root, trail.slice(0, -1)) : showPlaces())}>
            {t('newAgent.dev.sheet.back')}
          </button>
        )}
        <span style={{ flex: 1 }} />
        {step?.kind === 'folder' && trail.length > 0 && (
          <button type="button" className="ck-btn ck-btn--sm ck-btn--primary" data-testid="folder-sheet-open" disabled={busy || step.list === null} onClick={() => void open(step.root, trail)}>
            {busy ? t('newAgent.dev.sheet.opening') : t('newAgent.dev.sheet.openThis', { folder: trail[trail.length - 1]! })}
          </button>
        )}
        <button type="button" className="ck-btn ck-btn--sm ck-btn--secondary" disabled={busy} onClick={onClose}>
          {t('newAgent.dev.sheet.cancel')}
        </button>
      </div>
    </Sheet>
  );
}
