// "Bring my projects from Orca": the projects Orca keeps on this PC, each with a checkbox, and one Add button. The
// caller has already looked at Orca's files (read-only) and passes the answer in. It is the content only; the
// Bring my chats sheet wraps it. Nothing leaves this computer.
import { useState } from 'react';
import { addProjectsToSidebar, type OrcaImportApi, type OrcaProject } from '../../lib/orcaImport';
import { errorSentence } from '../../lib/sayError';
import { readProjects, pathKey } from '../../lib/sidebarProjects';

export const ORCA_BUTTON = 'Bring my projects from Orca';

export function BringOrcaProjects({ projects, api, onBack }: { projects: readonly OrcaProject[]; api: OrcaImportApi; onBack: () => void }) {
  const added = new Set(readProjects().map((p) => pathKey(p.path)));
  const free = projects.filter((p) => p.exists && !added.has(pathKey(p.path)));
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(free.map((p) => p.path)));
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = (path: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const accepted = await api.check([...picked]);
      setDone(addProjectsToSidebar(accepted));
    } catch (e) {
      setError(errorSentence(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="orca-projects">
      <button type="button" className="bc-back" onClick={onBack}>
        ‹ Back
      </button>
      <p className="ck-sub">Projects Orca keeps on this PC. Orca is only read, never changed. Nothing leaves this computer.</p>
      {error && (
        <p className="bc-error" role="alert">
          {error}
        </p>
      )}
      {done !== null ? (
        <p className="ck-sub" role="status">
          {done === 0 ? 'Nothing new to add.' : done === 1 ? '1 project added.' : `${done} projects added.`}
        </p>
      ) : (
        <>
          <ul className="bc-rows" aria-label="Orca projects">
            {projects.map((p) => {
              const already = added.has(pathKey(p.path));
              const usable = p.exists && !already;
              return (
                <li key={p.path}>
                  <label>
                    <input type="checkbox" checked={usable && picked.has(p.path)} disabled={!usable} onChange={() => toggle(p.path)} />
                    <span>{p.name}</span>
                    <span className="ck-sub">{!p.exists ? ' Folder not found' : already ? ' Already added' : ` ${p.path}`}</span>
                  </label>
                </li>
              );
            })}
          </ul>
          {projects.length === 0 && <p className="ck-sub">Orca has no projects on this PC.</p>}
          <div className="bc-actions">
            <button type="button" className="ck-btn ck-btn--primary" disabled={busy || picked.size === 0} onClick={() => void add()}>
              {picked.size > 0 ? `Add (${picked.size})` : 'Add'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
