// The result card (P10): when a turn ends, one card under the conversation: what was done in two lines, the files that
// changed (+/-) and the tests line when the PC knows it. Tap it and it opens full screen, like a document: summary, files, the
// diff. Buttons: Ask to fix (fills the message box, sends nothing), Keep (hides the card) and Share. The summary comes from the
// PC (`GET /panes/{id}/result`, built from recorded facts, not a model); when the PC has none, the card shows only the files the
// chat itself shows and "Read all".
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../i18n";
import type { BridgeClient } from "../../lib/bridge-types";
import type { ChatTurn } from "../../lib/sessionChatModel";
import type { PaneResult } from "../../lib/phone-upload";
import {
  diffLineKind,
  keepTurn,
  keptTurn,
  lastAnswer,
  parsePatch,
  resultFiles,
  shareText,
  totals,
  type ResultFile,
} from "../../lib/phone-result";
import "../../styles/phone-compose.css";

const MAX_CARD_FILES = 3;

function minutesWords(
  t: ReturnType<typeof useT>,
  ms: number | null | undefined,
): string | null {
  if (!ms || ms <= 0) return null;
  const minutes = Math.round(ms / 60000);
  return minutes < 1
    ? t("phone.result.lessThanMin")
    : t("phone.result.minutes", { n: minutes });
}

/** The first sentence of the text, cut at 160 characters. Null for no text. */
function firstSentence(text: string | null): string | null {
  if (!text) return null;
  const flat = text.replace(/\s+/g, " ").trim();
  const end = flat.search(/[.!?。！？](\s|$)/);
  const one = end >= 0 ? flat.slice(0, end + 1) : flat;
  return one.length > 160 ? `${one.slice(0, 157)}…` : one;
}

function countsLine(
  t: ReturnType<typeof useT>,
  files: readonly ResultFile[],
  result: PaneResult | null,
): string | null {
  const sum = totals(files, result);
  if (sum.count === 0) return null;
  const base =
    sum.count === 1
      ? t("phone.result.oneFile")
      : t("phone.result.files", { n: sum.count });
  return sum.added !== null
    ? `${base} · +${sum.added} −${sum.deleted ?? 0}`
    : base;
}

function FileRow({ file }: { file: ResultFile }) {
  return (
    <li className="ph-rfile">
      <span className="ph-rfile-path">{file.path}</span>
      {file.added !== null && (
        <span className="ph-rfile-n">
          <b className="ph-add">+{file.added}</b>{" "}
          <b className="ph-del">{`−${file.deleted ?? 0}`}</b>
        </span>
      )}
    </li>
  );
}

export function ResultCard({
  bridge,
  paneId,
  turn,
  onAskFix,
  onReadAll,
}: {
  bridge: BridgeClient | null;
  paneId: string;
  /** The last turn, which has ended. */
  turn: ChatTurn;
  /** Puts this text in the message box. */
  onAskFix: (text: string) => void;
  /** Close the card's screen and show the turn in the chat. */
  onReadAll: (turnId: string) => void;
}) {
  const t = useT();
  const [result, setResult] = useState<PaneResult | null>(null);
  const [open, setOpen] = useState(false);
  const [kept, setKept] = useState(() => keptTurn(paneId) === turn.id);
  const [shared, setShared] = useState<string | null>(null);
  const anchor = useRef<HTMLElement>(null);

  useEffect(() => {
    setKept(keptTurn(paneId) === turn.id);
    setResult(null);
    setOpen(false);
    setShared(null);
  }, [paneId, turn.id]);

  // The PC's summary of the turn, asked once when the turn ends. A failed or missing answer leaves the chat-only card.
  useEffect(() => {
    if (!bridge?.paneResult || kept) return;
    let live = true;
    bridge
      .paneResult(paneId)
      .then((answer) => {
        if (live) setResult(answer);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [bridge, paneId, turn.id, kept]);

  const files = useMemo(() => resultFiles(turn, result), [turn, result]);
  const answer = useMemo(() => lastAnswer(turn), [turn]);
  const known = result?.available === true;
  const counts = countsLine(t, files, result);
  const took = minutesWords(t, result?.durationMs ?? turn.durationMs);
  // One sentence on the outcome: the first sentence of what the agent said last, else the PC's own sentence.
  const summary = known ? (firstSentence(answer) || result?.sentence?.trim() || "") : "";
  const heading = result?.failed
    ? t("phone.result.failed")
    : took
      ? t("phone.result.doneIn", { time: took })
      : t("phone.result.done");
  const fixText = t("phone.result.fixText");

  if (kept) return null;
  // A turn that changed no file and ran no check has no card: the answer in the chat is enough.
  if (files.length === 0 && !result?.tests) return null;

  const keep = () => {
    keepTurn(paneId, turn.id);
    setKept(true);
    setOpen(false);
  };
  const share = async () => {
    const text = shareText(
      [heading, summary, counts ?? "", result?.tests ?? ""]
        .filter((p) => p !== "")
        .join("\n"),
      files,
    );
    try {
      if (typeof navigator.share === "function") {
        await navigator.share({ title: heading, text });
        setShared(null);
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        setShared(t("phone.result.copied"));
      } else {
        setShared(t("phone.result.shareOff"));
      }
    } catch {
      // The person closed the share sheet: nothing to say.
    }
  };
  const askFix = () => {
    setOpen(false);
    onAskFix(fixText);
  };

  return (
    <>
      <section
        ref={anchor}
        className="ph-result"
        aria-label={t("phone.result.aria")}
        data-testid="phone-result-card"
      >
        <button
          type="button"
          className="ph-result-body"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
        >
          <span className="ph-result-head">
            <svg className="ph-result-tick" viewBox="0 0 24 24" aria-hidden="true">
              <path d="m5 12.5 4.5 4.5L19 7.5" />
            </svg>
            {heading}
          </span>
          {summary !== "" && <span className="ph-result-sum">{summary}</span>}
          {counts && (
            <span className="ph-result-meta">
              {[counts, result?.tests].filter(Boolean).join(" · ")}
            </span>
          )}
          {!known && files.length > 0 && (
            <ul className="ph-rfiles">
              {files.slice(0, MAX_CARD_FILES).map((f) => (
                <FileRow key={f.path} file={f} />
              ))}
              {files.length > MAX_CARD_FILES && (
                <li className="ph-rfile-more">
                  {t("phone.result.more", { n: files.length - MAX_CARD_FILES })}
                </li>
              )}
            </ul>
          )}
        </button>
        <div className="ph-result-actions">
          {known ? (
            <>
              <button type="button" className="ph-result-main" data-testid="phone-result-open" onClick={() => setOpen(true)}>
                {t("phone.result.openChanges")}
              </button>
              <button type="button" onClick={askFix}>
                {t("phone.result.askFix")}
              </button>
              <button type="button" onClick={keep}>
                {t("phone.result.keep")}
              </button>
            </>
          ) : (
            <button type="button" onClick={() => onReadAll(turn.id)}>
              {t("phone.result.readAll")}
            </button>
          )}
        </div>
      </section>
      {open &&
        createPortal(
          <ResultScreen
            bridge={bridge}
            paneId={paneId}
            heading={heading}
            summary={summary}
            counts={counts}
            result={result}
            files={files}
            shared={shared}
            onClose={() => setOpen(false)}
            onAskFix={askFix}
            onKeep={keep}
            onShare={() => void share()}
            onReadAll={() => {
              setOpen(false);
              onReadAll(turn.id);
            }}
          />,
          // The screen lives at the top of the phone's own root, so the header and the drawer cannot cover it.
          anchor.current?.closest(".ph") ?? document.body,
        )}
    </>
  );
}

function ResultScreen({
  bridge,
  paneId,
  heading,
  summary,
  counts,
  result,
  files,
  shared,
  onClose,
  onAskFix,
  onKeep,
  onShare,
  onReadAll,
}: {
  bridge: BridgeClient | null;
  paneId: string;
  heading: string;
  summary: string;
  counts: string | null;
  result: PaneResult | null;
  files: readonly ResultFile[];
  shared: string | null;
  onClose: () => void;
  onAskFix: () => void;
  onKeep: () => void;
  onShare: () => void;
  onReadAll: () => void;
}) {
  const t = useT();
  const [patch, setPatch] = useState<{ text: string; cut: boolean } | null>(
    null,
  );
  const [patchState, setPatchState] = useState<"loading" | "ready" | "none">(
    bridge?.paneResult ? "loading" : "none",
  );
  const close = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    close.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (!bridge?.paneResult) return;
    let live = true;
    bridge
      .paneResult(paneId, true)
      .then((answer) => {
        if (!live) return;
        if (
          answer.available &&
          typeof answer.patch === "string" &&
          answer.patch !== ""
        ) {
          setPatch({ text: answer.patch, cut: answer.patchCut === true });
          setPatchState("ready");
        } else setPatchState("none");
      })
      .catch(() => live && setPatchState("none"));
    return () => {
      live = false;
    };
  }, [bridge, paneId]);

  const blocks = useMemo(() => (patch ? parsePatch(patch.text) : []), [patch]);
  return (
    <div
      className="ph-rscreen"
      role="dialog"
      aria-modal="true"
      aria-label={t("phone.result.screenAria")}
      data-testid="phone-result-screen"
    >
      <header className="ph-rscreen-head">
        <button
          ref={close}
          type="button"
          className="ph-rscreen-back"
          aria-label={t("phone.result.close")}
          onClick={onClose}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M15 5l-7 7 7 7" />
          </svg>
        </button>
        <h2>{heading}</h2>
      </header>
      <div className="ph-rscreen-body">
        {summary !== "" && <p className="ph-rscreen-sum">{summary}</p>}
        {counts && (
          <p className="ph-result-meta">
            {[counts, result?.tests].filter(Boolean).join(" · ")}
          </p>
        )}
        {files.length > 0 && (
          <>
            <h3>{t("phone.result.filesTitle")}</h3>
            <ul className="ph-rfiles">
              {files.map((f) => (
                <FileRow key={f.path} file={f} />
              ))}
            </ul>
          </>
        )}
        <h3>{t("phone.result.diffTitle")}</h3>
        {patchState === "loading" && (
          <p className="ph-result-meta">{t("phone.result.loading")}</p>
        )}
        {patchState === "none" && (
          <p className="ph-result-meta">{t("phone.result.noDiff")}</p>
        )}
        {blocks.map((block, index) => (
          <details
            key={`${block.path}:${index}`}
            className="ph-diff"
            open={blocks.length === 1}
          >
            <summary>{block.path || t("phone.result.changes")}</summary>
            <pre>
              {block.lines.map((line, i) => (
                <span key={i} className={`ph-dl ph-dl-${diffLineKind(line)}`}>
                  {line}
                  {"\n"}
                </span>
              ))}
            </pre>
          </details>
        ))}
        {patch?.cut && (
          <p className="ph-result-meta">{t("phone.result.cut")}</p>
        )}
        <button type="button" className="ph-result-link" onClick={onReadAll}>
          {t("phone.result.readAll")}
        </button>
      </div>
      <footer className="ph-rscreen-actions">
        <button type="button" onClick={onAskFix}>
          {t("phone.result.askFix")}
        </button>
        <button type="button" onClick={onKeep}>
          {t("phone.result.keep")}
        </button>
        <button type="button" onClick={onShare}>
          {t("phone.result.share")}
        </button>
        {shared && (
          <p className="ph-rscreen-note" role="status">
            {shared}
          </p>
        )}
      </footer>
    </div>
  );
}
