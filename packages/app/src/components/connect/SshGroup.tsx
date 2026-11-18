// Connect > Devices > "Other computers (SSH)": machines you sign in to over SSH. Terminal only, and apart from My PCs (Potato to
// Potato) and My phone. It reuses the SSH pieces of Settings > Devices: SshForm (add), SshPanel (open a terminal, the same panel
// the sidebar's Where menu shows) and sshApi. The extra settings of the form stay out of this page.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useT } from "../../i18n";
import { errorSentence } from "../../lib/sayError";
import {
  sshApi,
  sshStateSentence,
  type SshApi,
  type SshHost,
} from "../../lib/ssh";
import { SshForm } from "../devices/SshForm";
import { SshPanel } from "../devices/PlacePanels";

type Seen = { state: "ok" | "bad"; line?: string };

function Sheet({
  title,
  onClose,
  testId,
  children,
}: {
  title: string;
  onClose: () => void;
  testId: string;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <div className="cx-scrim" data-testid={testId}>
      <div className="cx-sheet" role="dialog" aria-label={title}>
        <div className="cx-sheet-head">
          <h3>{title}</h3>
          <button
            type="button"
            className="cx-btn cx-quiet"
            aria-label={t("connect.close")}
            onClick={onClose}
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function SshGroup({
  api = sshApi,
  onOpenPane,
}: {
  api?: SshApi;
  /** A terminal was opened: show that pane. */ onOpenPane?: (
    paneId: string,
  ) => void;
}) {
  const t = useT();
  const [hosts, setHosts] = useState<SshHost[] | null>(null);
  const [seen, setSeen] = useState<Record<string, Seen>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const load = useCallback(() => {
    api
      .hosts()
      .then((h) => setHosts(Array.isArray(h) ? h : []))
      .catch(() => setHosts([]));
  }, [api]);
  useEffect(load, [load]);
  const check = (id: string) => {
    setBusy(id);
    api
      .checkSaved(id)
      .then((c) =>
        setSeen((m) => ({
          ...m,
          [id]:
            c.state === "ok"
              ? { state: "ok" }
              : { state: "bad", line: sshStateSentence(c, true) ?? undefined },
        })),
      )
      .catch((e: unknown) =>
        setSeen((m) => ({
          ...m,
          [id]: { state: "bad", line: errorSentence(e) },
        })),
      )
      .finally(() => {
        setBusy(null);
        load();
      });
  };
  const closeSheet = () => {
    setOpenId(null);
    setAsking(false);
    setRemoveError(null);
  };
  const remove = (id: string) => {
    api
      .remove(id)
      .then(() => {
        closeSheet();
        load();
      })
      .catch(() => setRemoveError(t("connect.ssh.removeFailed")));
  };
  const open = hosts?.find((h) => h.id === openId) ?? null;
  const sub = (h: SshHost) => {
    const s = seen[h.id];
    if (s?.state === "ok") return t("connect.ssh.online");
    if (s?.state === "bad") return s.line ?? "";
    return h.checkedAt
      ? t("connect.ssh.checked", {
          when: new Date(h.checkedAt * 1000).toLocaleDateString(),
        })
      : t("connect.ssh.never");
  };
  return (
    <section
      className="cx-group"
      data-testid="connect-ssh-group"
      aria-label={t("connect.ssh.title")}
    >
      <div className="cx-ghead">
        <h2>{t("connect.ssh.title")}</h2>
        <button
          type="button"
          className="cx-btn"
          data-testid="connect-ssh-add"
          onClick={() => setAdding(true)}
        >
          {t("connect.ssh.add")}
        </button>
      </div>
      {hosts !== null && hosts.length === 0 && (
        <p className="cx-note" data-testid="connect-ssh-empty">
          {t("connect.ssh.empty")}
        </p>
      )}
      {hosts !== null && hosts.length > 0 && (
        <ul className="cx-list" data-testid="connect-ssh-list">
          {hosts.map((h) => (
            <li
              key={h.id}
              className="cx-row"
              data-testid={`connect-ssh-${h.id}`}
            >
              <span
                className={`cx-dot${seen[h.id]?.state === "ok" ? " ok" : ""}`}
                aria-hidden="true"
              />
              <div className="cx-main">
                <button
                  type="button"
                  className="cx-namebtn"
                  onClick={() => setOpenId(h.id)}
                >
                  {h.name}
                </button>
                <div className="cx-sub">
                  {t("connect.ssh.sub")} · {sub(h)}
                </div>
              </div>
              <button
                type="button"
                className="cx-btn cx-quiet"
                disabled={busy !== null}
                data-testid={`connect-ssh-check-${h.id}`}
                onClick={() => check(h.id)}
              >
                {busy === h.id
                  ? t("connect.ssh.checking")
                  : t("connect.ssh.check")}
              </button>
            </li>
          ))}
        </ul>
      )}
      {adding && (
        <Sheet
          title={t("connect.ssh.addTitle")}
          onClose={() => setAdding(false)}
          testId="connect-ssh-add-sheet"
        >
          <SshForm
            plain
            api={api}
            onCancel={() => setAdding(false)}
            onSaved={() => {
              setAdding(false);
              load();
            }}
          />
        </Sheet>
      )}
      {open && (
        <Sheet
          title={t("connect.ssh.openTitle", { name: open.name })}
          onClose={closeSheet}
          testId="connect-ssh-sheet"
        >
          <SshPanel
            host={open}
            api={api}
            onStarted={(paneId) => {
              closeSheet();
              onOpenPane?.(paneId);
            }}
          />
          {asking ? (
            <div
              className="cx-confirm"
              role="alertdialog"
              data-testid="connect-ssh-remove-confirm"
            >
              <p>{t("connect.ssh.removeAsk", { name: open.name })}</p>
              <div className="cx-row-actions">
                <button
                  type="button"
                  className="cx-btn cx-primary"
                  data-testid="connect-ssh-remove-yes"
                  onClick={() => remove(open.id)}
                >
                  {t("connect.ssh.removeYes")}
                </button>
                <button
                  type="button"
                  className="cx-btn"
                  onClick={() => setAsking(false)}
                >
                  {t("connect.ssh.removeNo")}
                </button>
              </div>
            </div>
          ) : (
            <div className="cx-row-actions">
              <button
                type="button"
                className="cx-btn cx-quiet"
                data-testid={`connect-ssh-remove-${open.id}`}
                onClick={() => setAsking(true)}
              >
                {t("connect.ssh.remove")}
              </button>
            </div>
          )}
          {removeError && (
            <p
              className="cx-note"
              role="alert"
              data-testid="connect-ssh-remove-error"
            >
              {removeError}
            </p>
          )}
        </Sheet>
      )}
    </section>
  );
}
