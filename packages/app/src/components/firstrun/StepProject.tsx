// Screen 2: the folder of the first project. Recent first, then the system picker. Every folder passes
// Simple mode's broad-folder guard (`plain_check_folder`, Rust) before it counts. Git is not asked for here
// (it is asked for only when a task needs it), and the footer's "Skip for now" leaves this screen empty.
import { errorSentence } from '../../lib/sayError';
import { useCallback, useEffect, useState } from 'react';
import type { RecentProject, ShipApi } from '../../lib/ship-api';
import { stateHint as rawStateHint } from '../../lib/ship-model';
import { t, useT } from '../../i18n';
import type { SimpleApi } from '../simple/simple-api';
import { T } from './copy';
import type { ProjectPick } from './model';

type Ship = Pick<ShipApi, 'recent' | 'pickFolder' | 'forget'>;

/** The hint under a recent folder, in the current language. */
const stateHint = (state: RecentProject['state']): string => (rawStateHint(state) ? t(`firstRun.hint.${state}` as 'firstRun.hint.missing') : '');

/** What each refusal from Rust says here. */
export function folderText(code: string | null): string {
  switch (code) {
    case 'FOLDER_TOO_BROAD':
      return T.tooBroad;
    case 'FOLDER_TOO_BIG':
      return T.tooBig;
    case 'FOLDER_MISSING':
      return T.missing;
    default:
      return T.failedFolder;
  }
}

/**
 * The demo runs in the folder itself and only reads, so the old "too big to copy" refusal does not apply
 * here. Only the broad-folder guard (a home folder, Documents) still refuses.
 */
export const refusal = (check: { ok: boolean; code?: string }): string | null => (check.ok || check.code === 'FOLDER_TOO_BIG' ? null : (check.code ?? 'FOLDER_FAILED'));

/** The app's own scratch folders (the doctor's, a side question's, anything in the temp or app-data folder) are not projects. */
export function isInternalFolder(path: string): boolean {
  const p = path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return /(^|\/)(potato-workspace-doctor|side-question|pm-store-check-[^/]*)$/.test(p) || /\/appdata\/local\/temp(\/|$)/.test(p) || p.includes('/com.potatodev.workspace') || /^\/tmp(\/|$)/.test(p);
}

/** A recent folder inside another listed one (a subfolder of a repo already there) is left out. */
export function withoutNested<T extends { path: string; state: string }>(list: T[]): T[] {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const roots = list.filter((p) => p.state !== 'missing').map((p) => norm(p.path));
  return list.filter((p) => { const me = norm(p.path); return !roots.some((r) => r !== me && me.startsWith(r + '/')); });
}

const errText = (err: unknown): string => (errorSentence(err)).replace(/^[A-Z_]+: /, '');

export function StepProject({
  project,
  ship,
  simple,
  onProject,
}: {
  project: ProjectPick | null;
  ship: Ship;
  simple: Pick<SimpleApi, 'checkFolder'>;
  onProject: (project: ProjectPick | null) => void;
}) {
  useT();
  const [recent, setRecent] = useState<RecentProject[] | null>(null);
  /** Folders the guard refuses, by path (so a row says so before it is clicked). */
  const [broad, setBroad] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(() => {
    ship
      .recent()
      .then((list) => {
        const shown = withoutNested(list.filter((p) => !isInternalFolder(p.path)));
        setRecent(shown);
        for (const p of shown) {
          if (p.state === 'missing') continue;
          simple
            .checkFolder(p.path)
            .then((check) => {
              const code = refusal(check);
              if (code) setBroad((b) => ({ ...b, [p.path]: code }));
            })
            .catch(() => undefined);
        }
      })
      .catch(() => setRecent([]));
  }, [ship, simple]);

  useEffect(load, [load]);

  const choose = async (found: RecentProject) => {
    setProblem(null);
    if (found.state === 'missing') return;
    try {
      const check = await simple.checkFolder(found.path);
      const code = refusal(check);
      if (code) {
        onProject(null);
        setProblem(folderText(code));
        return;
      }
    } catch {
      onProject(null);
      setProblem(T.failedFolder);
      return;
    }
    onProject({ path: found.path, name: found.name, state: found.state });
  };

  const pick = async () => {
    setProblem(null);
    try {
      const found = await ship.pickFolder();
      if (found) {
        load();
        await choose(found);
      }
    } catch (err) {
      setProblem(errText(err));
    }
  };

  const forget = (found: RecentProject) => {
    ship
      .forget(found.path)
      .catch(() => undefined)
      .finally(load);
  };

  return (
    <section className="fr-step" aria-labelledby="fr-project-t">
      <h1 className="ck-title" id="fr-project-t">{T.projectTitle}</h1>
      <p className="fr-lead">{T.projectLead}</p>

      {project && (
        <div className="fr-picked" data-testid="picked-project">
          <span className="fr-picked-name">{project.name}</span>
          <span className="fr-path" title={project.path}>{project.path}</span>
          <span className="fr-picked-ok">{T.projectChosen}</span>
        </div>
      )}

      {problem && (
        <p className="fr-problem" role="alert">
          {problem}
        </p>
      )}

      <h2 className="fr-cap">{T.recent}</h2>
      {recent === null && <p className="fr-hint">{T.checking}</p>}
      {recent?.length === 0 && <p className="fr-hint">{T.noRecent}</p>}
      <ul className="fr-list" aria-label={T.recent}>
        {recent?.map((p) => {
          const refused = broad[p.path];
          const off = p.state === 'missing' || Boolean(refused);
          return (
            <li key={p.path} className="fr-list-row">
              <button
                type="button"
                className="fr-row"
                data-selected={project?.path === p.path ? 'true' : undefined}
                disabled={off}
                onClick={() => void choose(p)}
                title={p.path}
              >
                <span className="fr-row-main">
                  <span className="fr-row-name">{p.name}</span>
                  <span className="fr-path">{p.path}</span>
                </span>
                {(refused || stateHint(p.state)) && <span className="fr-row-hint">{refused ? folderText(refused).split('.')[0] : stateHint(p.state)}</span>}
              </button>
              {p.state === 'missing' && (
                <button type="button" className="ck-btn ck-btn--plain ck-btn--sm" aria-label={`${T.remove} ${p.name}`} onClick={() => forget(p)}>
                  {T.remove}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <div className="fr-actions">
        <button type="button" className="ck-btn ck-btn--secondary" onClick={() => void pick()}>
          {T.chooseFolder}
        </button>
      </div>
    </section>
  );
}
