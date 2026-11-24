import { errorSentence } from '../../lib/sayError';
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../i18n";
import { useHost } from "../../lib/host/context";
import {
  checkpointsApiFor,
  type Checkpoint,
  type CheckpointList,
  type CheckpointsApi,
  type FileChange,
} from "../../lib/cockpit-api";
import {
  checkpointTitle,
  formatAgo,
  formatDelta,
  lastTurnStart,
  oneEndPerTurn,
} from "./history-model";
import { RestoreSheet } from "./RestoreSheet";
import { restoreWithUndo, type Notify } from "./restore-flow";
import { BranchSheet } from "./BranchSheet";
import type { BranchFrom } from "../../lib/branch-from";

const errText = (e: unknown): string =>
  errorSentence(e);

/**
 * The History tab: one row per checkpoint, newest first. "Restore" puts the project's files back
 * to that point (after saving the current state as a checkpoint, so it can itself be undone).
 */
export function History({
  paneId,
  status,
  now,
  notify,
  api: given,
  sharedWith = [],
  agentName = "the agent",
  onWhatBroke,
  onSeeDay,
}: {
  paneId: string;
  status: string;
  now: number;
  notify: Notify;
  api?: CheckpointsApi;
  /** Labels of the other live panes working in this pane's folder. */
  sharedWith?: string[];
  /** The agent's name, for "Before Claude's question". */
  agentName?: string;
  /** Opens "What broke the tests?" for this pane. Absent: no button. */
  onWhatBroke?: (paneId: string) => void;
  /** Opens the Today page (Labs). Absent: no link. */
  onSeeDay?: () => void;
}) {
  const t = useT();
  const host = useHost();
  const api = useMemo(() => given ?? checkpointsApiFor(host), [given, host]);
  const [listing, setListing] = useState<CheckpointList | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, FileChange[] | string>>({});
  const [pending, setPending] = useState<Checkpoint | null>(null);
  // The "Branch from here" sheet, opened from a row's save point.
  const [branchFrom, setBranchFrom] = useState<BranchFrom | null>(null);
  // The primary "Undo last turn" asks with its own title; a row's Restore names the row.
  const [undoing, setUndoing] = useState(false);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const running = status === "running";

  const load = useCallback(async () => {
    try {
      const next = await api.checkpointsList(paneId);
      if (!alive.current) return;
      setListing(next);
      setError(null);
    } catch (e) {
      if (alive.current) setError(errText(e));
    }
  }, [api, paneId]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    setListing(undefined);
    setOpen(null);
    setDiffs({});
    setPending(null);
    setUndoing(false);
    setBranchFrom(null);
  }, [paneId]);

  // A turn starting or ending is what creates checkpoints, so reload on every status change.
  useEffect(() => {
    void load();
  }, [load, status]);

  const toggle = (item: Checkpoint) => {
    if (open === item.id) {
      setOpen(null);
      return;
    }
    setOpen(item.id);
    if (diffs[item.id] !== undefined) return;
    api
      .checkpointDiff(paneId, item.id)
      .then(
        (files) =>
          alive.current && setDiffs((d) => ({ ...d, [item.id]: files })),
      )
      .catch(
        (e) =>
          alive.current && setDiffs((d) => ({ ...d, [item.id]: errText(e) })),
      );
  };

  const confirmRestore = async () => {
    if (!pending) return;
    const target = pending;
    setBusy(true);
    const report = await restoreWithUndo(api, paneId, target, notify);
    setPending(null);
    setUndoing(false);
    if (report) {
      setDiffs({});
      await load();
    }
    if (alive.current) setBusy(false);
  };

  if (error) {
    return (
      <div className="ck-empty">
        <h2 className="ck-section">{t("r10.hist.unavailable")}</h2>
        <p className="ck-sub">{error}</p>
      </div>
    );
  }
  if (listing === undefined) return <p className="ck-sub ck-pad">{t("r10.loading")}</p>;
  if (listing.state === "too_big") {
    return (
      <div className="ck-empty">
        <h2 className="ck-section">{t("r10.hist.tooBigTitle")}</h2>
        <p className="ck-sub">
          {t("r10.hist.tooBig")}
        </p>
      </div>
    );
  }
  if (listing.state === "off" || listing.state === "no_git") {
    return (
      <div className="ck-empty">
        <h2 className="ck-section">
          {listing.state === "off" ? t("r10.hist.offTitle") : t("r10.hist.gitTitle")}
        </h2>
        <p className="ck-sub">
          {listing.state === "off"
            ? t("r10.hist.offBody")
            : listing.message}
        </p>
      </div>
    );
  }
  if (listing.items.length === 0) {
    return (
      <div className="ck-empty">
        <h2 className="ck-section">{t("r10.hist.noneTitle")}</h2>
        <p className="ck-sub">
          {t("r10.hist.noneBody")}
        </p>
      </div>
    );
  }

  const lastStart = lastTurnStart(listing.items);

  return (
    <>
      <div className="ck-scroll ck-fade-in">
        <div className="ck-hist-head">
          <p className="ck-hist-note">
            {t("r10.hist.note")}
            {running && ` ${t("r10.hist.noteRunning")}`}
          </p>
          {lastStart && (
            <button
              type="button"
              className="ck-btn ck-btn--sm ck-btn--primary"
              disabled={running || busy}
              title={running ? t("r10.hist.interruptFirst") : undefined}
              onClick={() => {
                setUndoing(true);
                setPending(lastStart);
              }}
            >
              {t("r10.hist.undoLast")}
            </button>
          )}
          {onSeeDay && (
            <button type="button" className="ck-btn ck-btn--sm ck-btn--secondary" onClick={onSeeDay}>
              {t("timeline.seeDay")}
            </button>
          )}
          {onWhatBroke && (
            <button
              type="button"
              className="ck-btn ck-btn--sm ck-btn--secondary"
              onClick={() => onWhatBroke(paneId)}
            >
              {t("r10.hist.whatBroke")}
            </button>
          )}
        </div>
        <ol className="ck-hist" aria-label={t("r10.hist.list")}>
          {oneEndPerTurn(listing.items).map((item, at, rows) => {
            const expanded = open === item.id;
            const diff = diffs[item.id];
            return (
              <li key={item.id} className="ck-hist-item" data-kind={item.kind}>
                <div className="ck-hist-row">
                  <button
                    type="button"
                    className="ck-hist-main"
                    aria-expanded={expanded}
                    onClick={() => toggle(item)}
                  >
                    <span
                      className="ck-hist-time"
                      title={new Date(item.atMs).toLocaleString()}
                    >
                      {formatAgo(now - item.atMs)}
                    </span>
                    <span className="ck-hist-label">
                      <span className="ck-hist-title">
                        {checkpointTitle(item, agentName)}
                      </span>
                      {item.note && (
                        <span className="ck-hist-sub">{item.note}</span>
                      )}
                    </span>
                    <span className="ck-hist-delta">
                      {/* The oldest save point counts the whole folder against nothing: that is a starting point, not a change. */}
                      {at === rows.length - 1 && item.kind === "before" ? t("r14.hist.start") : formatDelta(item)}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="ck-btn ck-btn--sm ck-btn--secondary ck-hist-restore"
                    disabled={running || busy}
                    title={running ? t("r10.hist.interruptFirst") : undefined}
                    onClick={() => {
                      setUndoing(false);
                      setPending(item);
                    }}
                  >
                    {t("r10.hist.restore")}
                  </button>
                  <button
                    type="button"
                    className="ck-btn ck-btn--sm ck-btn--secondary ck-hist-branch"
                    onClick={() => setBranchFrom({ kind: "save_point", checkpoint_id: item.id })}
                  >
                    {t("r10.branch.title")}
                  </button>
                </div>
                {expanded && (
                  <div className="ck-hist-files">
                    {diff === undefined ? (
                      <span className="ck-sub">{t("r10.loading")}</span>
                    ) : typeof diff === "string" ? (
                      <span className="ck-sub">{diff}</span>
                    ) : diff.length === 0 ? (
                      <span className="ck-sub">{t("r10.hist.noChanges")}</span>
                    ) : (
                      <ul>
                        {diff.map((f) => (
                          <li key={f.path}>
                            <span className="ck-hist-status">{f.status}</span>
                            <span className="ck-hist-path">{f.path}</span>
                            <span className="ck-hist-delta">
                              {f.binary
                                ? t("r10.hist.binary")
                                : `+${f.added} −${f.deleted}`}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </div>

      {pending && (
        <RestoreSheet
          title={undoing ? "Undo the last turn?" : `Restore "${checkpointTitle(pending, agentName)}"?`}
          confirmLabel={undoing ? "Undo last turn" : undefined}
          sharedWith={sharedWith}
          busy={busy}
          onCancel={() => {
            setPending(null);
            setUndoing(false);
          }}
          onConfirm={() => void confirmRestore()}
        />
      )}

      {branchFrom && (
        <BranchSheet
          paneId={paneId}
          from={branchFrom}
          onClose={() => setBranchFrom(null)}
          onStarted={(view) => notify(`Branch started. ${view.toLabel} works in a separate copy.`)}
        />
      )}
    </>
  );
}
