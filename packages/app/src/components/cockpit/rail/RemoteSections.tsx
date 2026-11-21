// The right panel of a chat that runs on another computer (SSH): its branch, its changed files and its file tree, READ ONLY.
// Everything shown here is text the far machine sent, rendered as plain text (never as markup). Nothing here writes: there is no
// edit, stage, commit or create. A folder is read when it is opened, the branch and changes when the panel opens, when a chat turn
// ends and when "Refresh" is pressed. Nothing polls: every read is a full ssh connection.
import { useState } from 'react';
import { useT } from '../../../i18n';
import { openFileTab } from '../../../lib/file-tabs';
import { farErrorText, farFolderOf, useFar, type FarChange, type FarStatus, type Loaded, type RemoteFsApi } from '../../../lib/remoteFs';
import { FileGlyph } from './FileGlyph';
import { RailSection } from './RailSection';
import { baseName } from './railFormat';
import '../../../styles/files.css';

export type StatusFar = { value: Loaded<FarStatus>; reload: () => void };

/** One shared read of the branch and the changes for the sections of this panel. */
export function useRemoteStatus(paneId: string, refreshKey: string, api: RemoteFsApi, enabled: boolean): StatusFar {
  return useFar((fresh) => api.status(paneId, fresh), refreshKey, [paneId, api], enabled);
}

function Failed({ message, onRetry, testId }: { message: string; onRetry: () => void; testId: string }) {
  const t = useT();
  return (
    <div className="rp-row is-empty" role="alert" data-testid={testId}>
      <span className="rp-name">{message}</span>
      <button type="button" className="rp-btn" onClick={onRetry}>
        {t('devices.ssh.fs.retry')}
      </button>
    </div>
  );
}

function branchText(s: FarStatus, t: ReturnType<typeof useT>): string {
  if (s.detached) return t('devices.ssh.fs.branchDetached');
  const name = s.branch ?? '';
  const base = s.unborn ? t('devices.ssh.fs.branchUnborn', { branch: name }) : name;
  const extra = [s.ahead > 0 ? t('devices.ssh.fs.ahead', { n: s.ahead }) : '', s.behind > 0 ? t('devices.ssh.fs.behind', { n: s.behind }) : '', s.gone ? t('devices.ssh.fs.upstreamGone') : ''].filter(Boolean);
  return extra.length ? `${base} · ${extra.join(', ')}` : base;
}

/** Where it runs, the folder there and the git branch. */
export function RemoteEnvSection({ name, cwd, far }: { name: string; cwd: string; far: StatusFar }) {
  const t = useT();
  const folder = farFolderOf(cwd);
  const v = far.value;
  const branch = v.state === 'ready' ? branchText(v.data, t) : null;
  return (
    <RailSection id="env" title={t('rail.env.title')} summary={[name, branch].filter(Boolean).join(' · ')} testId="rail-remote-env">
      <div className="rp-row">
        <span className="rp-k">{t('rail.env.runsOn')}</span>
        <span className="rp-v">{name}</span>
      </div>
      <div className="rp-row" title={folder}>
        <span className="rp-k">{t('rail.env.folder')}</span>
        <span className="rp-v">{baseName(folder) || folder}</span>
      </div>
      {v.state === 'ready' && (
        <div className="rp-row" title={branch ?? ''} data-testid="rail-remote-branch">
          <span className="rp-k">{t('rail.env.branch')}</span>
          <span className="rp-v rp-mono">{branch}</span>
        </div>
      )}
      {v.state === 'error' && v.code === 'SSH_FS_NOT_REPO' && (
        <div className="rp-row" data-testid="rail-remote-branch">
          <span className="rp-k">{t('rail.env.branch')}</span>
          <span className="rp-v is-dim">{t('devices.ssh.fs.notGit')}</span>
        </div>
      )}
    </RailSection>
  );
}

const MARK: Record<FarChange['kind'], string> = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', copied: 'C', new: 'N', conflict: 'U', changed: 'M' };
const SHOWN = 30;

/** The files git says are changed, as a read-only list. */
export function RemoteChangesSection({ name, far }: { name: string; far: StatusFar }) {
  const t = useT();
  const v = far.value;
  const summary = v.state === 'ready' ? String(v.data.changes.length) : '';
  return (
    <RailSection id="chg" title={t('rail.chg.title')} summary={summary} testId="rail-remote-chg">
      {v.state === 'loading' && <div className="rp-row is-empty">{t('devices.ssh.fs.loading', { name })}</div>}
      {v.state === 'error' && <Failed message={farErrorText(v, name)} onRetry={far.reload} testId="rail-remote-chg-error" />}
      {v.state === 'ready' && v.data.changes.length === 0 && <div className="rp-row is-empty">{t('devices.ssh.fs.noChanges')}</div>}
      {v.state === 'ready' && v.data.changes.length > 0 && (
        <ul className="ck-ftree" aria-label={t('rail.chg.title')} data-testid="rail-remote-changes">
          {v.data.changes.slice(0, SHOWN).map((c, i) => (
            <li key={`${i}:${c.path}`} className="ck-ftree-row" title={c.staged ? `${c.path} · ${t('devices.ssh.fs.staged')}` : c.path}>
              <span className="ck-ftree-mark" data-mark={MARK[c.kind]} role="img" aria-label={t(`devices.ssh.fs.kind.${c.kind}`)}>
                {MARK[c.kind]}
              </span>
              <span className="ck-ftree-name">{c.path}</span>
              {c.staged && <span className="ck-ftree-dir">{t('devices.ssh.fs.staged')}</span>}
            </li>
          ))}
        </ul>
      )}
      {v.state === 'ready' && (v.data.changes.length > SHOWN || v.data.more) && <p className="ck-rail-more">{t('devices.ssh.fs.changesMore', { n: Math.min(SHOWN, v.data.changes.length) })}</p>}
      {v.state !== 'loading' && (
        <button type="button" className="rp-row rp-btn" onClick={far.reload} data-testid="rail-remote-refresh">
          <span className="rp-k">{t('devices.ssh.fs.refresh')}</span>
        </button>
      )}
    </RailSection>
  );
}

/** One folder's entries, read when it is shown. A file opens in a read-only tab; a folder opens in place. */
function Folder({ paneId, name, path, depth, refreshKey, api }: { paneId: string; name: string; path: string; depth: number; refreshKey: string; api: RemoteFsApi }) {
  const t = useT();
  const { value, reload } = useFar((fresh) => api.list(paneId, path, fresh), refreshKey, [paneId, path, api]);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  if (value.state === 'loading') return <p className="ck-rail-empty">{t('devices.ssh.fs.loading', { name })}</p>;
  if (value.state === 'error') return <Failed message={farErrorText(value, name)} onRetry={reload} testId="rail-remote-files-error" />;
  const l = value.data;
  const toggle = (n: string) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (!next.delete(n)) next.add(n);
      return next;
    });
  return (
    <>
      {l.entries.length === 0 && <p className="ck-rail-empty">{t('devices.ssh.fs.empty')}</p>}
      {l.entries.map((e) => {
        const rel = path ? `${path}/${e.name}` : e.name;
        const pad = { paddingLeft: 6 + depth * 12 };
        if (e.kind === 'dir') {
          const isOpen = open.has(e.name);
          return (
            <li key={e.name} role="none">
              <button type="button" role="treeitem" aria-expanded={isOpen} className="ck-ftree-row is-dir" style={pad} onClick={() => toggle(e.name)}>
                <span className="ck-ftree-twist" aria-hidden="true">
                  {isOpen ? '▾' : '▸'}
                </span>
                <span className="ck-ftree-name">{e.name}</span>
              </button>
              {isOpen && (
                <ul className="ck-ftree" role="group">
                  <Folder paneId={paneId} name={name} path={rel} depth={depth + 1} refreshKey={refreshKey} api={api} />
                </ul>
              )}
            </li>
          );
        }
        if (e.kind === 'file') {
          return (
            <li key={e.name} role="none">
              <button type="button" role="treeitem" aria-selected={false} className="ck-ftree-row" style={pad} onClick={() => openFileTab(paneId, rel)}>
                <FileGlyph name={e.name} />
                <span className="ck-ftree-name">{e.name}</span>
              </button>
            </li>
          );
        }
        return (
          <li key={e.name} role="none">
            <span role="treeitem" aria-disabled="true" className="ck-ftree-row" style={pad} title={t('devices.ssh.fs.linkNo')}>
              <span className="ck-ftree-name">{e.name}</span>
              {e.kind === 'link' && <span className="ck-ftree-dir">{t('devices.ssh.fs.linkTag')}</span>}
            </span>
          </li>
        );
      })}
      {l.more && <p className="ck-rail-more">{t('devices.ssh.fs.more', { n: l.entries.length })}</p>}
      {l.skipped > 0 && <p className="ck-rail-more">{t('devices.ssh.fs.skipped', { n: l.skipped })}</p>}
    </>
  );
}

/** The project folder as a tree. */
export function RemoteFilesSection({ paneId, name, refreshKey, api }: { paneId: string; name: string; refreshKey: string; api: RemoteFsApi }) {
  const t = useT();
  return (
    <RailSection id="files" title={t('files.title')} testId="rail-remote-files">
      <ul className="ck-ftree" role="tree" aria-label={t('devices.ssh.fs.treeLabel', { name })} data-testid="rail-remote-tree">
        <Folder paneId={paneId} name={name} path="" depth={0} refreshKey={refreshKey} api={api} />
      </ul>
    </RailSection>
  );
}
