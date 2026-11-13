// Settings > Team. Two things people do: start a team, or join one. Nothing else is on screen until a team exists.
//   - Start: team name, your name, then how to connect (a free relay in your own Cloudflare account is the
//     recommended way; your own address or a shared folder sit under "Other ways").
//   - Join: paste the invite message; the link (and the code, if it came along) are picked out of it.
//   - On a team: a status line, the invite (link, code, QR), the people (with Let in / Decline right there),
//     Options (Use Team, projects), and Leave team at the bottom.
// Messages are end-to-end encrypted; the relay (or the shared folder) only moves ciphertext. No ids are shown:
// people are names, the team is its name.
import { errorSentence } from '../../../lib/sayError';
import { t, useT } from '../../../i18n';
import { lendApi, type LendApi } from "../../../lib/lend";
import { useLend } from "../../lend/useLend";
import QRCode from "qrcode";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { formatCode, parsePastedInvite } from "../../../lib/team-invite";
import {
  pingText,
  teamApi,
  type InviteView,
  type MemberView,
  type TeamApi,
  type TeamConfigView,
  type TeamCreateInput,
  type TeamJoinInput,
} from "../../../lib/team";
import { ConfirmSheet, Switch } from "../controls";
import { Btn, FieldInput, Note } from "../settings-ui";
import { ExternalLink, RelaySheet } from "./RelaySheet";
import { useTeamPings } from "./useTeamPings";

const errText = (err: unknown): string =>
  errorSentence(err);
const splitLines = (text: string) =>
  text
    .split("\n")
    .map((n) => n.trim())
    .filter(Boolean);
const clock = (ms: number): string =>
  new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Where people learn to host their own relay (Cloudflare in a few clicks, or Docker). */
export const RELAY_HELP_URL =
  "https://github.com/Potato-dev-inc/potato-workspace/blob/main/relay/README.md";

function roleWords(m: MemberView): string {
  if (m.admin || m.roles.includes("admin")) return t("teamPage.role.owner");
  return m.roles.includes("approve") ? t("teamPage.role.answer") : t("teamPage.role.watching");
}

function githubText(login: string | null, confirmed: boolean): string | null {
  return login ? `GitHub: ${login}${confirmed ? "" : ` ${t("teamPage.claimed")}`}` : null;
}

/** The team's name inside an invite link (`n=`), or null. Shown so the person sees what they are about to join. */
function inviteTeamName(link: string): string | null {
  try {
    const n = new URLSearchParams(link.slice(link.indexOf("?") + 1)).get("n");
    return n && n.trim() ? n.trim() : null;
  } catch {
    return null;
  }
}

function hostOf(address: string): string {
  try {
    return new URL(address).host || address;
  } catch {
    return address;
  }
}

/**
 * A sheet is drawn over the whole Settings window. Inside the page's card it would be cut off by the card's
 * edges, so it goes to the window itself when there is one (the tests render the page on its own).
 */
function Sheet({ children }: { children: ReactNode }) {
  const windowEl =
    typeof document === "undefined"
      ? null
      : document.querySelector(".settings");
  return windowEl ? createPortal(children, windowEl) : <>{children}</>;
}

// ---------- connection status ----------

export interface Connection {
  state: "ok" | "wait" | "bad" | "paused";
  title: string;
  detail: string;
  /** The one button: Try again, or Turn on. */
  action: "retry" | "on" | null;
}

/** One status line for the top of the page. Says what is wrong when something is. */
export function connectionOf(view: TeamConfigView): Connection {
  if (!view.enabled)
    return {
      state: "paused",
      title: t("teamPage.conn.paused"),
      detail: t("teamPage.conn.pausedDetail"),
      action: "on",
    };
  if (view.transport === "folder") {
    return view.error
      ? {
          state: "bad",
          title: t("teamPage.conn.folderBad"),
          detail: view.error,
          action: "retry",
        }
      : {
          state: "ok",
          title: t("teamPage.conn.connected"),
          detail: t("teamPage.conn.viaFolder"),
          action: null,
        };
  }
  if (view.link === "denied") {
    return {
      state: "bad",
      title: t("teamPage.conn.denied"),
      detail: t("teamPage.conn.deniedDetail"),
      action: null,
    };
  }
  if (view.link === "offline") {
    return {
      state: "bad",
      title: t("teamPage.conn.offline"),
      detail: view.error || t("teamPage.conn.offlineDetail", { host: hostOf(view.relay) }),
      action: "retry",
    };
  }
  if (view.error)
    return {
      state: "bad",
      title: t("teamPage.conn.wrong"),
      detail: view.error,
      action: "retry",
    };
  if (view.link === "live")
    return {
      state: "ok",
      title: t("teamPage.conn.connected"),
      detail: t("teamPage.conn.viaRelay"),
      action: null,
    };
  if (view.link === "polling")
    return {
      state: "ok",
      title: t("teamPage.conn.connected"),
      detail: t("teamPage.conn.viaRelaySlow"),
      action: null,
    };
  return {
    state: "wait",
    title: t("teamPage.conn.connecting"),
    detail: t("teamPage.conn.reaching"),
    action: null,
  };
}

function StatusLine({
  view,
  busy,
  onAction,
}: {
  view: TeamConfigView;
  busy: boolean;
  onAction: (a: "retry" | "on") => void;
}) {
  const t = useT();
  const c = connectionOf(view);
  return (
    <div className="tp-status" data-state={c.state} role="status">
      <span className="tp-dot" aria-hidden="true" />
      <div className="tp-status-text">
        <strong>{c.title}</strong>
        <small>{c.detail}</small>
      </div>
      {c.action && (
        <Btn
          small
          disabled={busy}
          onClick={() => onAction(c.action as "retry" | "on")}
        >
          {c.action === "on" ? t("teamPage.turnOn") : t("teamPage.tryAgain")}
        </Btn>
      )}
    </div>
  );
}

// ---------- the page ----------

/** How often the page re-reads the relay link while it is not up. */
// Share an agent (Labs): these screens load when they are drawn, so the settings bundle does not carry them.
const RequestUsage = lazy(() => import("../../lend/RequestUsage").then((m) => ({ default: m.RequestUsage })));
const MemberLends = lazy(() => import("../../lend/Borrowed").then((m) => ({ default: m.MemberLends })));

const LINK_REFRESH_MS = 3000;

export function TeamPage({
  api = teamApi,
  lend: lendClient = lendApi,
  displayName = "",
  onSaved,
}: {
  api?: TeamApi;
  /** Share an agent (Labs): Request usage and the lends on each person's row. */
  lend?: LendApi;
  displayName?: string;
  onSaved?: () => void;
}) {
  const t = useT();
  const [view, setView] = useState<TeamConfigView | null>(null);
  const [projects, setProjects] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"choose" | "start" | "join">("choose");
  const [guess, setGuess] = useState("");
  const [justCreated, setJustCreated] = useState(false);
  const [removing, setRemoving] = useState<MemberView | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const projectsEdited = useRef(false);
  const lend = useLend(lendClient);
  // Pings need a relay team (a shared folder has no mailbox to time) and a backend that can ping.
  const canPing = !!view && view.enabled && view.transport === "relay" && !!api.ping;
  const pings = useTeamPings(api, canPing);

  const take = (v: TeamConfigView) => {
    setView(v);
    if (!projectsEdited.current) setProjects(v.projects.join("\n"));
  };

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .configGet()
        .then((v) => alive && take(v))
        .catch((err) => alive && setError(errText(err)));
    void load();
    // Someone asking to join, or the connection changing, shows up without a reload.
    const off = api.onChanged?.(() => void load());
    return () => {
      alive = false;
      void off?.then((unlisten) => unlisten());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  // The link to the relay changes without a `team://changed` event (the first connect finishes, the relay
  // drops and comes back), so while a relay link is not up, read the settings again every few seconds.
  const waitingOnRelay =
    !!view &&
    view.enabled &&
    view.transport === "relay" &&
    view.link !== "live" &&
    view.link !== "polling";
  useEffect(() => {
    if (!waitingOnRelay) return;
    let alive = true;
    const timer = window.setInterval(() => {
      api
        .configGet()
        .then((v) => alive && take(v))
        .catch(() => undefined);
    }, LINK_REFRESH_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, waitingOnRelay]);

  // "Your name": the name in Settings, else this computer's sign-in name. Only a first guess; always editable.
  useEffect(() => {
    if (displayName.trim()) {
      setGuess(displayName.trim());
      return;
    }
    let alive = true;
    void Promise.resolve(api.defaultName?.())
      .then((n) => alive && typeof n === "string" && setGuess(n))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [api, displayName]);

  /** Run a call that returns the new settings view. */
  const run = async (
    what: () => Promise<TeamConfigView>,
    saved = false,
  ): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      take(await what());
      if (saved) onSaved?.();
      return true;
    } catch (err) {
      setError(errText(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const save = (enabled: boolean) =>
    run(() => api.configSet({ enabled, projects: splitLines(projects) }), true);

  const body = () => {
    if (!view) return error ? null : <Note>{t("teamPage.loading")}</Note>;
    if (view.joining) {
      return (
        <div className="tp-wait">
          <h3 className="tp-h">
            {t("teamPage.waiting", { team: view.joining })}
          </h3>
          <p className="tp-sub">{t("teamPage.waitingHelp")}</p>
          <div>
            <Btn
              disabled={busy}
              onClick={() => {
                setMode("choose");
                void run(() => api.leave());
              }}
            >
              {t("teamPage.cancelRequest")}
            </Btn>
          </div>
        </div>
      );
    }
    if (view.team === "") {
      if (mode === "start") {
        return (
          <StartForm
            api={api}
            busy={busy}
            guess={guess}
            onBack={() => setMode("choose")}
            onCreate={async (input) => {
              const ok = await run(() => api.create(input), true);
              if (ok) setJustCreated(true);
              return ok;
            }}
          />
        );
      }
      if (mode === "join") {
        return (
          <JoinForm
            busy={busy}
            guess={guess}
            onBack={() => setMode("choose")}
            onJoin={(input) => run(() => api.join(input), true)}
          />
        );
      }
      return (
        <div className="tp-choices">
          <button
            type="button"
            className="tp-choice"
            onClick={() => setMode("start")}
          >
            <strong>{t("teamPage.start")}</strong>
            <span>{t("teamPage.startHelp")}</span>
          </button>
          <button
            type="button"
            className="tp-choice"
            onClick={() => setMode("join")}
          >
            <strong>{t("teamPage.join")}</strong>
            <span>{t("teamPage.joinHelp")}</span>
          </button>
        </div>
      );
    }
    return (
      <>
        <div className="tp-head">
          <h3 className="tp-h">{view.teamName}</h3>
          <span className="tp-sub">
            {view.admin
              ? t("teamPage.youOwner")
              : t("teamPage.people", { count: view.members.length })}
          </span>
        </div>
        <StatusLine
          view={view}
          busy={busy}
          onAction={(a) => void save(a === "on" ? true : view.enabled)}
        />
        {view.admin && (
          <InviteBlock
            api={api}
            auto={justCreated || view.members.length <= 1}
          />
        )}

        {view.admin && view.joins.length > 0 && (
          <section className="tp-block" aria-label={t("teamPage.waitingJoin")}>
            <h4 className="tp-h4">{t("teamPage.waitingJoin")}</h4>
            <ul className="st-team-people" aria-label={t("teamPage.waitingJoin")}>
              {view.joins.map((j) => (
                <li key={j.id} className="st-team-member">
                  <div className="st-team-who">
                    <span>{t("teamPage.wantsJoin", { name: j.name })}</span>
                    <small>
                      {[githubText(j.github, false), j.device]
                        .filter(Boolean)
                        .join(" · ")}
                    </small>
                    {j.warning && (
                      <small className="st-team-warning" role="alert">
                        {j.warning}
                      </small>
                    )}
                  </div>
                  <Btn
                    small
                    primary
                    disabled={busy}
                    aria-label={t("teamPage.letInName", { name: j.name })}
                    onClick={() => void run(() => api.approveJoin(j.id))}
                  >
                    {t("teamPage.letIn")}
                  </Btn>
                  <Btn
                    small
                    disabled={busy}
                    aria-label={t("teamPage.declineName", { name: j.name })}
                    onClick={() => void run(() => api.declineJoin(j.id))}
                  >
                    {t("teamPage.decline")}
                  </Btn>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="tp-block" aria-label={t("teamPage.peopleTitle")}>
          <div className="st-team-people-head">
            <h4 className="tp-h4">{t("teamPage.peopleTitle")}</h4>
            {canPing && (
              <Btn small disabled={pings.busy} onClick={pings.ping}>
                {pings.busy ? t("teamPage.pinging") : t("teamPage.ping")}
              </Btn>
            )}
          </div>
          {canPing && pings.error && <Note>{pings.error}</Note>}
          <Suspense fallback={null}>
            <RequestUsage api={lendClient} team={api} lend={lend} variant="settings" />
          </Suspense>
          <ul className="st-team-people" aria-label={t("teamPage.peopleTitle")}>
            {view.members.map((m) => {
              const gh = githubText(m.github, m.githubConfirmed);
              return (
                <li key={m.id} className="st-team-member">
                  <div className="st-team-who">
                    <span>
                      {m.name}
                      {m.me && <span className="st-team-you"> {t("teamPage.you")}</span>}
                    </span>
                    {gh && <small>{gh}</small>}
                    {canPing &&
                      (m.deviceList ?? [])
                        .filter((d) => !d.current && pings.byDevice[d.id])
                        .map((d) => {
                          const p = pings.byDevice[d.id];
                          return (
                            <small
                              key={d.id}
                              className="st-team-ping"
                              data-ok={p.ok ? "true" : "false"}
                              title={p.ok ? undefined : (p.message ?? undefined)}
                            >
                              {(m.deviceList ?? []).length > 1 ? t("teamPage.deviceOf", { name: m.name, device: d.name }) : m.name} · {pingText(p)}
                            </small>
                          );
                        })}
                    <Suspense fallback={null}>
                      <MemberLends memberId={m.id} lend={lend} api={lendClient} />
                    </Suspense>
                  </div>
                  {view.admin && !m.me && m.github && !m.githubConfirmed && (
                    <Btn
                      small
                      disabled={busy}
                      onClick={() => void run(() => api.confirmGithub(m.id))}
                    >
                      {t("teamPage.confirmGithub")}
                    </Btn>
                  )}
                  <span className="st-team-role">{roleWords(m)}</span>
                  <span className="st-team-slot">
                    {view.admin && !m.me && (
                      <Btn small disabled={busy} onClick={() => setRemoving(m)}>
                        {t("settings.remove")}
                      </Btn>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="tp-block">
          <button
            type="button"
            className="tp-disclose"
            aria-expanded={optionsOpen}
            onClick={() => setOptionsOpen((o) => !o)}
          >
            <span>{t("teamPage.options")}</span>
            <span aria-hidden="true">{optionsOpen ? "−" : "+"}</span>
          </button>
          {optionsOpen && (
            <div className="tp-options">
              <div className="st-team-row">
                <span>{t("teamPage.useTeam")}</span>
                <Switch
                  checked={view.enabled}
                  label={t("teamPage.useTeam")}
                  disabled={busy}
                  onChange={(next) => void save(next)}
                />
              </div>
              <label className="st-team-row is-top">
                <span>{t("teamPage.projects")}</span>
                <textarea
                  className="st-field is-mono"
                  rows={2}
                  value={projects}
                  placeholder={t("teamPage.projectsPlaceholder")}
                  onChange={(e) => {
                    projectsEdited.current = true;
                    setProjects(e.target.value);
                  }}
                />
              </label>
              <Note>{t("teamPage.projectsHelp")}</Note>
              <div className="st-team-row">
                <span />
                <Btn
                  primary
                  disabled={busy}
                  onClick={() => void save(view.enabled)}
                >
                  {t("discord.save")}
                </Btn>
              </div>
              <Note>{t("teamPage.keysNote", { store: view.keyStore })}</Note>
              {view.profile && (
                <Note>{t("teamPage.profileNote", { profile: view.profile })}</Note>
              )}
            </div>
          )}
        </section>

        <div className="tp-leave">
          <Btn disabled={busy} onClick={() => setLeaving(true)}>
            {t("teamPage.leave")}
          </Btn>
        </div>
      </>
    );
  };

  return (
    <section className="st-team tp" aria-label={t("teamPage.aria")}>
      {view?.readError && (
        <Note role="alert">
          {t("teamPage.readError")}
          <span className="st-team-detail"> {view.readError}</span>
        </Note>
      )}
      {body()}
      {view && view.team === "" && !view.joining && view.error && (
        <Note role="alert">{view.error}</Note>
      )}
      {error && <Note role="alert">{error}</Note>}
      {removing && (
        <Sheet>
          <ConfirmSheet
            title={t("teamPage.removeTitle", { name: removing.name })}
            body={t("teamPage.removeBody")}
            confirmLabel={t("settings.remove")}
            onCancel={() => setRemoving(null)}
            onConfirm={() => {
              const id = removing.id;
              setRemoving(null);
              void run(() => api.removeMember(id));
            }}
          />
        </Sheet>
      )}
      {leaving && (
        <Sheet>
          <ConfirmSheet
            title={t("teamPage.leaveTitle")}
            body={t("teamPage.leaveBody")}
            confirmLabel={t("teamPage.leaveConfirm")}
            onCancel={() => setLeaving(false)}
            onConfirm={() => {
              setLeaving(false);
              setJustCreated(false);
              setMode("choose");
              void run(() => api.leave());
            }}
          />
        </Sheet>
      )}
    </section>
  );
}

// ---------- invite ----------

function InviteBlock({ api, auto }: { api: TeamApi; auto: boolean }) {
  const t = useT();
  const [invite, setInvite] = useState<InviteView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const [copied, setCopied] = useState<"link" | "code" | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const alive = useRef(true);

  const make = async () => {
    setMaking(true);
    setError(null);
    try {
      const v = await api.invite();
      if (alive.current) setInvite(v);
    } catch (err) {
      if (alive.current) setError(errText(err));
    } finally {
      if (alive.current) setMaking(false);
    }
  };

  useEffect(() => {
    alive.current = true;
    if (auto) void make();
    return () => {
      alive.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!invite || !canvasRef.current) return;
    // The same look as the phone pairing code. A QR that cannot be drawn leaves the link and the code.
    QRCode.toCanvas(canvasRef.current, invite.link, {
      width: 132,
      margin: 2,
      color: { dark: "#e8e8e8", light: "#121212" },
    }).catch(() => {});
  }, [invite]);

  const copy = async (what: "link" | "code") => {
    if (!invite) return;
    try {
      await navigator.clipboard.writeText(
        what === "link" ? invite.link : invite.code,
      );
      setCopied(what);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      setError(t("teamPage.copyFailed"));
    }
  };

  return (
    <section className="tp-block tp-invite" aria-label={t("teamPage.invite")}>
      <h4 className="tp-h4">{t("teamPage.inviteSomeone")}</h4>
      {!invite ? (
        <div className="tp-invite-empty">
          <p className="tp-sub">{t("teamPage.inviteHelp")}</p>
          <Btn primary disabled={making} onClick={() => void make()}>
            {making ? t("teamPage.making") : t("teamPage.make")}
          </Btn>
        </div>
      ) : (
        <>
          <p className="tp-send">{t("teamPage.sendThis")}</p>
          <div className="tp-invite-body">
            <canvas
              ref={canvasRef}
              className="st-invite-qr tp-qr"
              aria-label={t("teamPage.qrAria")}
            />
            <div className="tp-invite-side">
              <div className="st-invite-link">
                <input
                  className="st-field is-mono"
                  readOnly
                  value={invite.link}
                  aria-label={t("teamPage.linkAria")}
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Btn onClick={() => void copy("link")}>
                  {copied === "link" ? t("teamPage.copied") : t("settings.copy")}
                </Btn>
              </div>
              <div className="tp-code-line">
                <small>{t("teamPage.code")}</small>
                <span className="st-invite-code" aria-label={t("teamPage.codeAria")}>
                  {invite.code}
                </span>
                <Btn small onClick={() => void copy("code")}>
                  {copied === "code" ? t("teamPage.copied") : t("teamPage.copyCode")}
                </Btn>
              </div>
              <div className="tp-invite-foot">
                <small>{t("teamPage.expiresAt", { time: clock(invite.expiresAtMs) })}</small>
                <Btn small disabled={making} onClick={() => void make()}>
                  {t("teamPage.newInvite")}
                </Btn>
              </div>
            </div>
          </div>
        </>
      )}
      {error && <Note role="alert">{error}</Note>}
    </section>
  );
}

// ---------- start ----------

type Way = "relay" | "address" | "folder";

function StartForm({
  api,
  busy,
  guess,
  onBack,
  onCreate,
}: {
  api: TeamApi;
  busy: boolean;
  guess: string;
  onBack: () => void;
  onCreate: (input: TeamCreateInput) => Promise<boolean>;
}) {
  const t = useT();
  const [teamName, setTeamName] = useState("");
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [others, setOthers] = useState(false);
  const [way, setWay] = useState<Way>("address");
  const [relay, setRelay] = useState("");
  const [folder, setFolder] = useState("");
  const [deploying, setDeploying] = useState(false);
  const shownName = nameEdited ? name : guess;
  const named = !!teamName.trim() && !!shownName.trim();
  const create = (input: { relay?: string; folder?: string }) =>
    void onCreate({
      teamName: teamName.trim(),
      name: shownName.trim(),
      relay: input.relay ?? "",
      folder: input.folder ?? "",
    });

  return (
    <div className="tp-form">
      <div className="tp-form-top">
        <Btn small onClick={onBack}>
          {t("settings.back")}
        </Btn>
        <h3 className="tp-h">{t("teamPage.start")}</h3>
      </div>
      <label className="st-team-row">
        <span>{t("teamPage.teamName")}</span>
        <FieldInput
          value={teamName}
          placeholder="Acme" // i18n-ok: example
          maxLength={60}
          autoFocus
          onChange={(e) => setTeamName(e.target.value)}
        />
      </label>
      <label className="st-team-row">
        <span>{t("teamPage.yourName")}</span>
        <FieldInput
          value={shownName}
          placeholder="Maya" // i18n-ok: example
          maxLength={40}
          onChange={(e) => {
            setNameEdited(true);
            setName(e.target.value);
          }}
        />
      </label>

      <div className="tp-way tp-way-main">
        <div>
          <strong>{t("teamPage.createRelay")}</strong>{" "}
          <span className="tp-tag">{t("teamPage.recommended")}</span>
          <p className="tp-sub">{t("teamPage.relayHelp")}</p>
        </div>
        <Btn
          primary
          disabled={busy || !named}
          onClick={() => setDeploying(true)}
        >
          {t("teamPage.createRelay")}
        </Btn>
      </div>

      <button
        type="button"
        className="tp-disclose"
        aria-expanded={others}
        onClick={() => setOthers((o) => !o)}
      >
        <span>{t("teamPage.otherWays")}</span>
        <span aria-hidden="true">{others ? "−" : "+"}</span>
      </button>
      {others && (
        <div className="tp-others">
          <div
            className="tp-seg"
            role="group"
            aria-label={t("teamPage.otherWaysAria")}
          >
            <button
              type="button"
              aria-pressed={way !== "folder"}
              onClick={() => setWay("address")}
            >
              {t("teamPage.ownAddress")}
            </button>
            <button
              type="button"
              aria-pressed={way === "folder"}
              onClick={() => setWay("folder")}
            >
              {t("teamPage.sharedFolderBtn")}
            </button>
          </div>
          {way === "folder" ? (
            <>
              <label className="st-team-row">
                <span>{t("teamPage.sharedFolder")}</span>
                <FieldInput
                  value={folder}
                  className="font-mono"
                  placeholder="D:\team\wire" // i18n-ok: example
                  onChange={(e) => setFolder(e.target.value)}
                />
              </label>
              <p className="tp-sub">{t("teamPage.folderHelp")}</p>
              <div>
                <Btn
                  primary
                  disabled={busy || !named || !folder.trim()}
                  onClick={() => create({ folder: folder.trim() })}
                >
                  {t("teamPage.createTeam")}
                </Btn>
              </div>
            </>
          ) : (
            <>
              <label className="st-team-row">
                <span>{t("teamPage.relayAddress")}</span>
                <FieldInput
                  value={relay}
                  className="font-mono"
                  placeholder="https://relay.example.com" // i18n-ok: example
                  onChange={(e) => setRelay(e.target.value)}
                />
              </label>
              <p className="tp-sub">
                {t("teamPage.hostOwn")}{" "}
                <ExternalLink href={RELAY_HELP_URL}>
                  {t("teamPage.howToHost")}
                </ExternalLink>
              </p>
              <div>
                <Btn
                  primary
                  disabled={busy || !named || !relay.trim()}
                  onClick={() => create({ relay: relay.trim() })}
                >
                  {t("teamPage.createTeam")}
                </Btn>
              </div>
            </>
          )}
        </div>
      )}
      {deploying && (
        <Sheet>
          <RelaySheet
            api={api}
            onClose={() => setDeploying(false)}
            onDone={(url) => {
              setDeploying(false);
              create({ relay: url });
            }}
          />
        </Sheet>
      )}
    </div>
  );
}

// ---------- join ----------

function JoinForm({
  busy,
  guess,
  onBack,
  onJoin,
}: {
  busy: boolean;
  guess: string;
  onBack: () => void;
  onJoin: (input: TeamJoinInput) => Promise<boolean>;
}) {
  const t = useT();
  const [text, setText] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [github, setGithub] = useState("");
  const found = useMemo(() => parsePastedInvite(text), [text]);
  const shownName = nameEdited ? name : guess;
  const teamName = found.link ? inviteTeamName(found.link) : null;
  const ready =
    !!found.link && code.replace("-", "").length === 8 && !!shownName.trim();

  return (
    <div className="tp-form">
      <div className="tp-form-top">
        <Btn small onClick={onBack}>
          {t("settings.back")}
        </Btn>
        <h3 className="tp-h">{t("teamPage.join")}</h3>
      </div>
      <label className="tp-paste">
        <span>{t("teamPage.pasteInvite")}</span>
        <textarea
          className="st-field is-mono"
          rows={3}
          aria-label={t("teamPage.linkAria")}
          placeholder="pm://team/join?…" // i18n-ok: example
          spellCheck={false}
          autoFocus
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            const p = parsePastedInvite(e.target.value);
            if (p.code) setCode(p.code);
          }}
        />
      </label>
      {text.trim() && !found.link && (
        <Note role="alert">{t("teamPage.notInvite")}</Note>
      )}
      {found.link && (
        <p className="tp-found" role="status">
          {teamName ? t("teamPage.inviteFoundFor", { team: teamName }) : t("teamPage.inviteFound")}
        </p>
      )}
      <label className="st-team-row">
        <span>{t("teamPage.code")}</span>
        <FieldInput
          value={code}
          className="font-mono"
          placeholder="ABCD-EFGH" // i18n-ok: example
          maxLength={9}
          onChange={(e) => setCode(formatCode(e.target.value))}
        />
      </label>
      {found.link && !code && (
        <p className="tp-sub">{t("teamPage.typeCode")}</p>
      )}
      <label className="st-team-row">
        <span>{t("teamPage.yourName")}</span>
        <FieldInput
          value={shownName}
          placeholder="Leo" // i18n-ok: example
          maxLength={40}
          onChange={(e) => {
            setNameEdited(true);
            setName(e.target.value);
          }}
        />
      </label>
      <label className="st-team-row">
        <span>{t("teamPage.githubLogin")}</span>
        <FieldInput
          value={github}
          placeholder={t("teamPage.optional")}
          maxLength={39}
          onChange={(e) => setGithub(e.target.value)}
        />
      </label>
      <div className="st-team-row">
        <span />
        <Btn
          primary
          disabled={busy || !ready}
          onClick={() =>
            void onJoin({
              link: found.link ?? "",
              code,
              name: shownName.trim(),
              github: github.trim() || null,
            })
          }
        >
          {t("teamPage.joinBtn")}
        </Btn>
      </div>
    </div>
  );
}
