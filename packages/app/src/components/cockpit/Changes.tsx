import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { t } from '../../i18n';
import { showUndo } from '../../lib/undo-bar';
import { markStep } from '../../lib/getting-started';
import { cockpitApi, type ChangeBlame, type WorktreeDiff, type WorktreeItem } from '../../lib/cockpit-api';
import { lineKind, plural, splitPatch, statusMark } from './diff';
import { blameLine } from './blame-line';
import { secondOpinionApi, type SecondOpinionApi } from '../../lib/second-opinion';
import { dragSourceProps } from '../dnd/dragSourceProps';
import { AnnotatedDiff } from './AnnotatedDiff';
import { anchorFindings, reviewHasConcerns } from './review-diff';
import { sendToAuthor, useReviewRun } from './second-opinion-store';
import { Sheet } from './Sheet';
import { CreatePrSheet } from './CreatePrSheet';
import { PrBlock } from './PrBlock';
import { agentLabel, useAgentRegistry } from '../../lib/agentRegistry';
import { shipApi, type PrRef, type ShipApi } from '../../lib/ship-api';
import { setupLine } from '../../lib/ship-model';
import { branchKeepWarning, branchLineage, type BranchView } from '../../lib/branch-from';
import { ChangedFiles } from '../simple/ChangedFiles';
import { SegTabs } from './SegTabs';
import { searchProjectFiles, type ProjectFileHit } from '../../lib/projectFiles';
import { splitPath } from './changes-rows';
import '../../styles/cockpit-changes.css';

/** The slice of the cockpit API this section needs (a test double can stand in for it). */
export type ChangesApi = Pick<
  typeof cockpitApi,
  'paneWorktree' | 'worktreeDiff' | 'worktreeMerge' | 'worktreeDiscard'
> &
  // Optional: a test double without it simply shows no blame.
  Partial<Pick<typeof cockpitApi, 'changesBlame'>>;

const ALL_FILES_LIMIT = 300;

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** What a separate copy is called on screen: never its branch. */
export function copyHeadline(copyLabel: string | undefined, base: string): string {
  return copyLabel ?? `Separate copy of ${base}`;
}

/** Refusals that get a plain sentence; the raw text stays in the tooltip (`title`). */
export function plainMergeError(raw: string): { text: string; title?: string } {
  if (/ORIGIN_DIRTY_OVERLAP/.test(raw)) {
    const files = /\(([^()]*)\)\s*$/.exec(raw.trim())?.[1];
    const sentence = 'Your project has unsaved changes to the same files. Save or undo them first.';
    return { text: files ? `${sentence} (${files})` : sentence, title: raw };
  }
  if (/MERGE_CONFLICT/.test(raw)) {
    const files = /\(([^()]*)\)\s*$/.exec(raw.trim())?.[1];
    const sentence = 'Some files changed in both places, so nothing was merged. Your project is unchanged and the copy is safe.';
    return { text: files ? `${sentence} (${files})` : sentence, title: raw };
  }
  if (/ORIGIN_DETACHED/.test(raw)) {
    return { text: "Your project isn't on a branch. Switch to a branch, then merge.", title: raw };
  }
  if (/ORIGIN_MERGE_IN_PROGRESS/.test(raw)) {
    return { text: 'Your project is in the middle of a merge. Finish or cancel it first.', title: raw };
  }
  return { text: raw };
}

/**
 * "Changes" in the Receipt tab: what an isolated agent changed in its git worktree, with Merge and
 * Discard. Renders nothing for a pane that is not working in a worktree.
 */
export function Changes({
  paneId,
  status,
  api = cockpitApi,
  reviewApi = secondOpinionApi,
  secondOpinion,
  hideActions = false,
  ship = shipApi,
  copyLabel,
  plain = false,
  listFiles = searchProjectFiles,
}: {
  paneId: string;
  /** Simple mode: plain words, no branch, no diffs, no Merge / Discard (Simple owns those). */
  plain?: boolean;
  /** Show the files and diffs only (no Merge / Discard): another surface owns those decisions. */
  hideActions?: boolean;
  /** Shown in place of "Separate copy of <base>" when another surface owns the separate copy ("Separate copy of feat/billing"). */
  copyLabel?: string;
  status: string;
  api?: ChangesApi;
  /**
   * The Second opinion block. It renders between the file list and Merge / Discard, so the evidence
   * comes before the decision; without a worktree to merge it renders on its own.
   */
  secondOpinion?: ReactNode;
  /** Where "Send to <agent>" on a second-opinion note goes (a test double can stand in). */
  reviewApi?: SecondOpinionApi;
  /** Create PR and the GitHub checks (a test double can stand in). */
  ship?: ShipApi;
  /** "All files": the project's files (a test double can stand in). */
  listFiles?: (paneId: string, query: string, limit?: number) => Promise<ProjectFileHit[]>;
}) {
  const [item, setItem] = useState<WorktreeItem | null>(null);
  const [diff, setDiff] = useState<WorktreeDiff | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  // Changes (what the agent touched) or All files (the project's files, plain).
  const [view, setView] = useState<'changes' | 'all'>('changes');
  const [allFiles, setAllFiles] = useState<ProjectFileHit[] | null>(null);
  useEffect(() => {
    if (view !== 'all') return;
    let cancelled = false;
    listFiles(paneId, '', ALL_FILES_LIMIT).then(
      (hits) => {
        if (!cancelled) setAllFiles(hits);
      },
      () => {
        if (!cancelled) setAllFiles([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [view, paneId, listFiles]);
  const [sheet, setSheet] = useState<'merge' | null>(null);
  // A copy thrown away: hidden at once, deleted when the undo bar ends (lib/undo-bar.ts). Undo brings it back.
  const discarding = useRef<string | null>(null);
  const [prSheet, setPrSheet] = useState(false);
  const [prRound, setPrRound] = useState(0);
  // The branch this copy was made as, when it is one (Merge warns about it). Null for a normal copy.
  const [branch, setBranch] = useState<BranchView | null>(null);
  const listing = useAgentRegistry();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A finished second opinion on this worktree: its notes are pinned to the lines below.
  const review = useReviewRun(paneId);
  const reviewDone = review?.phase === 'done' && review.start?.source === 'worktree' ? review : null;
  const reviewHandle = reviewDone?.start?.handle;
  // Who last changed each file (from the turn summaries of the copy's folder). Nothing when unknown.
  const [blame, setBlame] = useState<Record<string, ChangeBlame>>({});
  useEffect(() => {
    if (!item?.path || !diff || !api.changesBlame) {
      setBlame({});
      return;
    }
    let cancelled = false;
    api
      .changesBlame(item.path, diff.changes.files.map((f) => f.path))
      .then((found) => {
        if (!cancelled) setBlame(found ?? {});
      })
      .catch(() => {
        if (!cancelled) setBlame({});
      });
    return () => {
      cancelled = true;
    };
  }, [api, item?.path, diff]);

  const load = useCallback(() => {
    let cancelled = false;
    api
      .paneWorktree(paneId)
      .then(async (found) => {
        if (cancelled) return;
        if (found && discarding.current === found.handle) {
          setItem(null);
          return;
        }
        setItem(found);
        if (found && found.exists) {
          const d = await api.worktreeDiff(found.repo, found.handle);
          if (!cancelled) setDiff(d);
        } else {
          setDiff(null);
        }
      })
      .catch(() => {
        // Not in the desktop shell, or the lookup failed: there is nothing to review.
        if (!cancelled) setItem(null);
      });
    return () => {
      cancelled = true;
    };
  }, [api, paneId]);

  useEffect(() => {
    setOpen(null);
    setNotice(null);
    setError(null);
    return load();
  }, [load, status]);

  useEffect(() => {
    if (hideActions || plain) return;
    let cancelled = false;
    branchLineage(paneId).then(
      (found) => {
        // A lookup with no answer reads as no branch (no warning), never as a crash.
        if (!cancelled) setBranch(found?.from ?? null);
      },
      () => {
        if (!cancelled) setBranch(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [paneId, status, hideActions, plain]);

  // Open the first file with a note once per review, so the notes are in view when they arrive.
  const openedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!reviewHandle || !diff || !reviewDone?.review || openedFor.current === reviewHandle) return;
    openedFor.current = reviewHandle;
    const first = [...anchorFindings(reviewDone.review.findings, splitPatch(diff.patch)).byFile.keys()][0];
    if (first) setOpen(first);
  }, [reviewHandle, diff, reviewDone]);

  if (!item) {
    return (
      <>
        {notice && <p className="ck-sub ck-pad">{notice}</p>}
        {secondOpinion}
      </>
    );
  }

  const files = diff?.changes.files ?? [];
  const bodies = diff ? splitPatch(diff.patch) : new Map<string, string[]>();
  const working = item.state === 'active';
  if (plain) return <ChangedFiles files={files} working={working} loaded={diff !== null} />;
  const total = diff?.changes;
  const notes = reviewDone?.review ? anchorFindings(reviewDone.review.findings, bodies).byFile : null;
  // A review that found problems: Merge stops being the obvious button and says what it is.
  const concerns = reviewHasConcerns(reviewDone?.review ?? null);
  // A branch copy: Merge brings in only its own changes, so the later work of the original chat is not in it.
  const keepWarning = branchKeepWarning(branch);

  const setup = item.setup ?? null;
  // A copy whose setup failed could not run its checks: Merge is not the obvious next step.
  const setupFailed = setup?.status === 'failed';
  const agentName = item.agent_type ? agentLabel(listing, item.agent_type) : 'the agent';

  const discardWithUndo = () => {
    const target = item;
    markStep('review');
    discarding.current = target.handle;
    setError(null);
    setItem(null);
    setDiff(null);
    setNotice('Discarded the separate copy.');
    showUndo({
      text: t('undo.copyDiscarded', { name: agentName }),
      failText: t('undo.commitFailed'),
      undo: () => {
        discarding.current = null;
        setNotice(null);
        load();
      },
      commit: async () => {
        try {
          await api.worktreeDiscard(target.repo, target.handle);
        } catch (err) {
          discarding.current = null;
          setError(errText(err));
          load();
          throw err;
        }
      },
    });
  };

  const merge = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await api.worktreeMerge(item.repo, item.handle);
      if (out.merged) {
        markStep('review');
        setNotice(`Merged into ${out.into}.`);
        setItem(null);
      } else {
        setNotice('Nothing to merge: the agent changed no files.');
      }
      setSheet(null);
    } catch (err) {
      setSheet(null);
      setError(errText(err));
      load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ck-changes" aria-label="Changes">
      <div className="ck-changes-head">
        <h2 className="ck-section">Changes</h2>
        <span className="ck-changes-state">{working ? 'Working' : 'Not merged yet'}</span>
      </div>
      <p className="ck-changes-meta">
        {copyHeadline(copyLabel, item.base)}
        {total && (
          <>
            {' · '}
            {plural(total.files_changed, 'file')}
            {' · '}
            <span className="ck-num ck-add">+{total.additions}</span> <span className="ck-num ck-del">−{total.deletions}</span>
          </>
        )}
      </p>

      {!copyLabel && (
        <details className="ck-details ck-changes-details">
          <summary>Details</summary>
          <dl className="ck-facts ck-facts--details">
            <div className="ck-facts-row">
              <dt>Branch</dt>
              <dd className="ck-mono">{item.branch}</dd>
            </div>
            <div className="ck-facts-row">
              <dt>Based on</dt>
              <dd className="ck-mono">{item.base}</dd>
            </div>
            <div className="ck-facts-row">
              <dt>Folder</dt>
              <dd className="ck-mono">{item.path}</dd>
            </div>
          </dl>
        </details>
      )}

      {setup && (
        <div className={`ck-changes-setup${setup.status === 'failed' ? ' is-failed' : ''}`}>
          <p className="ck-sub" role={setup.status === 'failed' ? 'alert' : undefined}>
            {setupLine(setup)}
          </p>
          {setup.status === 'failed' && setup.steps.some((st) => st.tail) && (
            <details className="ck-pr-details">
              <summary>Last lines of the output</summary>
              <pre className="ck-pr-command">{setup.steps.find((st) => !st.ok)?.tail}</pre>
            </details>
          )}
        </div>
      )}
      {item.pr && (
        <PrBlock
          key={prRound}
          repo={item.repo}
          handle={item.handle}
          pr={item.pr}
          agentName={agentName}
          ship={ship}
          onPr={(next: PrRef) => setItem((cur) => (cur ? { ...cur, pr: next } : cur))}
        />
      )}

      <div className="ck-changes-switch">
        <SegTabs
          label="Show"
          small
          value={view}
          onChange={setView}
          options={[
            { id: 'changes' as const, label: 'Changes', badge: total?.files_changed },
            { id: 'all' as const, label: 'All files' },
          ]}
        />
        {total && view === 'changes' && (
          <span className="ck-changes-total">
            <span className="ck-add">+{total.additions}</span> <span className="ck-del">−{total.deletions}</span>
          </span>
        )}
      </div>
      {view === 'all' && (
        <ul className="ck-changes-files ck-changes-all" data-testid="all-files">
          {(allFiles ?? []).map((h) => {
            const { dir, name } = splitPath(h.path);
            return (
              <li key={h.path} className="ck-changes-file ck-changes-file--plain" title={h.path}>
                <span className="ck-changes-path">
                  {dir && <span className="ck-changes-dir">{dir}</span>}
                  <span className="ck-changes-name">{name}</span>
                </span>
              </li>
            );
          })}
          {allFiles !== null && allFiles.length === 0 && <li className="ck-sub ck-pad">No files to show.</li>}
        </ul>
      )}
      {view === 'changes' && diff && files.length === 0 && <p className="ck-sub">No file changes yet.</p>}
      <ul className="ck-changes-files" hidden={view !== 'changes'}>
        {files.map((f) => {
          const lines = bodies.get(f.path);
          const who = blame[f.path] ? blameLine(blame[f.path]) : null;
          const isOpen = open === f.path;
          return (
            <li key={f.path}>
              <button
                type="button"
                className={`ck-changes-file${isOpen ? ' is-open' : ''}`}
                aria-expanded={isOpen}
                onClick={() => setOpen(isOpen ? null : f.path)}
                {...dragSourceProps({ kind: 'file', id: f.path, label: splitPath(f.path).name, meta: { paneId } })}
              >
                <span className={`ck-changes-mark ck-changes-mark--${f.status}`} aria-label={f.status}>
                  {statusMark(f.status)}
                </span>
                <span className="ck-changes-path" title={f.path}>
                  {splitPath(f.path).dir && <span className="ck-changes-dir">{splitPath(f.path).dir}</span>}
                  <span className="ck-changes-name">{splitPath(f.path).name}</span>
                </span>
                {who && (
                  <span className="ck-changes-blame" title={who.title}>
                    {who.text}
                  </span>
                )}
                <span className="ck-changes-counts">
                  {f.binary ? (
                    'binary'
                  ) : (
                    <>
                      {(f.additions > 0 || f.deletions === 0) && <span className="ck-add">+{f.additions}</span>}
                      {f.additions > 0 && f.deletions > 0 && ' '}
                      {f.deletions > 0 && <span className="ck-del">−{f.deletions}</span>}
                    </>
                  )}
                </span>
                {(notes?.get(f.path)?.length ?? 0) > 0 && (
                  <span className="ck-changes-notes">{plural(notes?.get(f.path)?.length ?? 0, 'note')}</span>
                )}
              </button>
              {isOpen && reviewDone?.start ? (
                <AnnotatedDiff
                  file={f.path}
                  lines={lines ?? []}
                  findings={notes?.get(f.path) ?? []}
                  agentLabel={reviewDone.start.authorLabel}
                  onSend={(file, line, text) => sendToAuthor(paneId, file, line, text, reviewApi).then(() => undefined)}
                  emptyText={diff?.patch_truncated ? 'Diff too large to show here.' : 'No textual changes.'}
                />
              ) : (
                isOpen && (
                  <pre className="ck-diff" aria-label={`Diff of ${f.path}`}>
                    {lines && lines.length > 0 ? (
                      lines.map((line, i) => (
                        <span key={i} className={`ck-diff-line ck-diff-${lineKind(line)}`}>
                          {line || ' '}
                        </span>
                      ))
                    ) : (
                      <span className="ck-diff-line ck-diff-ctx">
                        {diff?.patch_truncated ? 'Diff too large to show here.' : 'No textual changes.'}
                      </span>
                    )}
                  </pre>
                )
              )}
            </li>
          );
        })}
      </ul>
      {diff?.changes.truncated && <p className="ck-sub">Only the first {files.length} files are listed.</p>}

      {error && (
        <p className="ck-changes-error" role="alert" title={plainMergeError(error).title}>
          {plainMergeError(error).text}
        </p>
      )}
      {notice && <p className="ck-sub">{notice}</p>}

      {secondOpinion}

      {!hideActions && (
      <div className="ck-changes-actions">
        <button
          type="button"
          className={`ck-btn ${concerns || setupFailed ? 'ck-btn--secondary' : 'ck-btn--primary'}`}
          disabled={working || busy || item.state === 'missing'}
          title={working ? 'The agent is still working' : undefined}
          onClick={() => setSheet('merge')}
        >
          {concerns ? 'Merge anyway' : 'Merge'}
        </button>
        <button
          type="button"
          className="ck-btn ck-btn--secondary"
          disabled={working || busy || item.state === 'missing'}
          title={working ? 'The agent is still working' : undefined}
          onClick={() => setPrSheet(true)}
        >
          {item.pr ? 'Update PR' : 'Create PR'}
        </button>
        <button
          type="button"
          className="ck-btn ck-btn--secondary"
          disabled={working || busy}
          title={working ? 'The agent is still working' : undefined}
          onClick={discardWithUndo}
        >
          Discard
        </button>
        {setupFailed && <span className="ck-changes-hint">Setup failed, checks didn't run.</span>}
      </div>
      )}

      {prSheet && (
        <CreatePrSheet
          item={item}
          ship={ship}
          agentName={agentName}
          onClose={() => setPrSheet(false)}
          onDone={(pr, updated) => {
            setPrSheet(false);
            setItem({ ...item, pr: { ...pr, checks: undefined } });
            setPrRound((r) => r + 1);
            setNotice(updated ? 'Pushed the new commits to the pull request.' : `Draft pull request #${pr.number} created.`);
          }}
        />
      )}

      {sheet && (
        <Sheet labelledBy="ck-wt-t" onClose={busy ? undefined : () => setSheet(null)}>
            <h2 className="ck-section" id="ck-wt-t">
              {`Merge into ${item.base}?`}
            </h2>
            <p className="ck-sub">
              {`Brings ${plural(total?.files_changed ?? 0, 'changed file')} from this separate copy into ${item.base} and closes ${agentName}. If anything conflicts, nothing is merged.`}
            </p>
            {keepWarning && <p className="ck-sub ck-changes-keep-warning">{keepWarning}</p>}
            <div className="ck-sheet-actions">
              <button type="button" className="ck-btn ck-btn--secondary" autoFocus disabled={busy} onClick={() => setSheet(null)}>
                Cancel
              </button>
              <button type="button" className="ck-btn ck-btn--primary" disabled={busy} onClick={() => void merge()}>
                Merge
              </button>
            </div>
        </Sheet>
      )}
    </section>
  );
}
