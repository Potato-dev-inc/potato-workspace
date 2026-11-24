// The Project view: the project's name as a constant title, then Memory and Copies tabs.
// Memory is the one text every agent in a project reads. It is saved to
// `<project>/.potato-workspace/memory.md` and rendered into each agent's own instruction file.
import { errorSentence } from '../../lib/sayError';
import { t, useT } from '../../i18n';
import { useCallback, useEffect, useState } from 'react';
import { memoryApi, type MemoryApi, type MemoryTargetStatus, type MemoryView } from '../../lib/memory-api';
import { agentLabel, useAgentRegistry } from '../../lib/agentRegistry';
import { ProjectCopies } from './ProjectCopies';
import { SegTabs } from './SegTabs';
import { projectOfCwd } from '../../lib/ship-model';
import { projectLabel } from './shell-labels';

const STATUS_KEY = {
  in_sync: 'r21.mem.inSync',
  will_create: 'r21.mem.willCreate',
  will_add: 'r21.mem.willAdd',
  will_update: 'r21.mem.willUpdate',
  will_remove: 'r21.mem.willRemove',
  nothing: 'r21.mem.nothing',
  blocked: 'r21.mem.blocked',
} as const satisfies Record<MemoryTargetStatus, string>;

/** The count of memory lines, shown when nothing else is: "3 lines". */
function lineCount(text: string): string {
  const n = text.split('\n').filter((line) => line.trim() !== '').length;
  return n === 0 ? '' : t('r21.n.line', { count: n });
}

export function ProjectMemory({
  project,
  api = memoryApi,
  onClose,
}: {
  /** Folder of the selected pane; the backend falls back to the open project. */
  project?: string;
  api?: MemoryApi;
  onClose: () => void;
}) {
  useT();
  const listing = useAgentRegistry();
  const [view, setView] = useState<MemoryView | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [tab, setTab] = useState<'memory' | 'copies'>('memory');

  const apply = useCallback((next: MemoryView, keepDraft = false) => {
    setView(next);
    if (!keepDraft) setDraft(next.memory);
    setError(null);
  }, []);

  useEffect(() => {
    let live = true;
    api
      .get(project)
      .then((v) => live && apply(v))
      .catch((e) => live && setError(errorSentence(e)));
    return () => {
      live = false;
    };
  }, [api, project, apply]);

  const dirty = view !== null && draft !== view.memory;

  const run = async (job: () => Promise<MemoryView>, done: string, keepDraft = false) => {
    setBusy(true);
    setNote(null);
    try {
      const next = await job();
      apply(next, keepDraft);
      const problems = next.report?.errors ?? [];
      if (problems.length > 0) setError(problems.join(' '));
      else setNote(done);
    } catch (e) {
      setError(errorSentence(e));
    } finally {
      setBusy(false);
    }
  };

  const save = () => run(() => api.save(draft, project), t('r21.mem.saved'));
  const sync = () => run(() => api.sync(project), t('r21.mem.synced'), true);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (dirty && !busy) void save();
    }
  };

  const off = view !== null && (!view.global_enabled || !view.project_enabled);

  return (
    <div className="ck-memory" onKeyDown={onKeyDown}>
      <header className="ck-memory-head">
        <div>
          <h1 className="ck-title">{view ? projectLabel(view.project) : projectLabel(project) || t('r21.mem.project')}</h1>
          <p className="ck-sub">{tab === 'copies' ? t('r21.mem.subCopies') : t('r21.mem.subMemory')}</p>
        </div>
        <button type="button" className="ck-btn ck-btn--plain" onClick={onClose}>
          {t('r21.mem.close')}
        </button>
      </header>

      <div className="ck-memory-tabs">
        <SegTabs
          label={t('r21.mem.project')}
          value={tab}
          onChange={setTab}
          options={[
            { id: 'memory', label: t('r21.mem.tabMemory') },
            { id: 'copies', label: t('r21.mem.tabCopies') },
          ]}
        />
      </div>

      {tab === 'copies' && <ProjectCopies project={view?.project ?? projectOfCwd(project)?.path} />}

      {tab === 'memory' && (
        <>
      <textarea
        className="ck-memory-editor"
        aria-label={t('r21.mem.editor')}
        value={draft}
        placeholder={t('r21.mem.placeholder')}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        disabled={view === null}
      />

      <div className="ck-memory-actions">
        <button type="button" className="ck-btn ck-btn--primary" disabled={!dirty || busy} onClick={() => void save()}>
          {t('r21.mem.save')}
        </button>
        <button type="button" className="ck-btn ck-btn--secondary" disabled={view === null || busy} onClick={() => void sync()}>
          {t('r21.mem.sync')}
        </button>
        <span className="ck-memory-msg" role="status" aria-live="polite">
          {error ? <span className="ck-memory-err">{error}</span> : (note ?? (dirty ? t('r21.mem.unsaved') : view ? lineCount(view.memory) : ''))}
        </span>
      </div>

      <section aria-label={t('r21.mem.agentFiles')}>
        <h2 className="ck-section">{t('r21.mem.filesRead')}</h2>
        {off && (
          <p className="ck-sub ck-memory-off">
            {view && !view.global_enabled
              ? t('r21.mem.offGlobal')
              : t('r21.mem.offProject')}{' '}
            {t('r21.mem.noBlock')}
          </p>
        )}
        <ul className="ck-memory-files">
          {(view?.targets ?? []).map((target) => (
            <li key={target.path} className="ck-memory-file">
              <span className="ck-memory-path">{target.path}</span>
              <span className="ck-memory-agents">{target.agents.map((a) => agentLabel(listing, a)).join(', ')}</span>
              {target.user_content && <span className="ck-memory-tag">{t('r21.mem.ownText')}</span>}
              <span className={`ck-memory-status is-${target.status}`}>{t(STATUS_KEY[target.status])}</span>
            </li>
          ))}
        </ul>
        <p className="ck-sub ck-memory-fine">{t('r21.mem.fine')}</p>
      </section>

      <div className="ck-memory-switch">
        <span id="ck-memory-share">{t('r21.mem.share')}</span>
        <button
          type="button"
          role="switch"
          aria-checked={view?.project_enabled ?? true}
          aria-labelledby="ck-memory-share"
          className="ck-switch"
          disabled={view === null || busy}
          onClick={() => {
            const on = !(view?.project_enabled ?? true);
            void run(() => api.setProjectEnabled(on, project), on ? t('r21.mem.on') : t('r21.mem.removed'), true);
          }}
        >
          <span className="ck-switch-knob" />
        </button>
      </div>
        </>
      )}
    </div>
  );
}
