// Settings > Agents > Accounts: run one agent under several logins. Per agent that supports
// accounts: its accounts, "Add account", and "Open login pane" (starts the agent under that
// account so the user logs in once). Potato Workspace only points the CLI at a folder the user
// controls; it never reads or shares the credentials inside.
import { errorSentence } from '../../../lib/sayError';
import { SIGN_IN } from '../../../lib/glossary';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  accountsFor,
  tauriAccountsApi,
  type AccountsApi,
  type AccountsOverview,
} from '../../../lib/accounts';
import { agentLabel, useAgentRegistry } from '../../../lib/agentRegistry';
import { SettingBlock, Tip } from '../settings-ui';
import { CodeText } from '../../common/CodeText';

const TERMS = "Each sign-in is a folder you control. Potato Workspace only points the agent at it and never reads or shares what is inside. Check your provider's terms before using several sign-ins.";
/** Beside each sign-in: opens the agent's own window to sign in again. */
const SIGN_IN_AGAIN = 'Sign in again';
const BTN = 'rounded-lg border border-pm-border px-3 py-1.5 text-xs font-medium hover:bg-pm-border/40 disabled:opacity-50';

/** `only`: show just this agent (its page in Settings > Agents). */
export function AccountsGroup({ api = tauriAccountsApi, only }: { api?: AccountsApi; only?: string }) {
  const [data, setData] = useState<AccountsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const registry = useAgentRegistry();
  const loaded = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setData(await api.list());
      loaded.current = true;
    } catch (err) {
      // Never loaded: no desktop shell or an old backend, so there is nothing to configure.
      // Loaded before: keep what we have and say the refresh failed.
      if (loaded.current) setError(`Could not refresh the sign-ins: ${errorSentence(err)}`);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Runs one change. Resolves true when it worked, false when it failed (the error is shown). */
  const run = async (work: () => Promise<unknown>, done?: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await work();
      if (done) setNote(done);
      await refresh();
      return true;
    } catch (err) {
      setError(errorSentence(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const shownAgents = data ? data.agents.filter((a) => !only || a.agent_id === only) : [];
  if (!data || shownAgents.length === 0) return null;

  return (
    <SettingBlock
      label={SIGN_IN.rowLabel}
      description={
        <>
          Use more than one sign-in per agent. Each lives in its own folder. <Tip text={TERMS} label="About sign-ins" />
        </>
      }
    >
      {error && (
        <p role="alert" className="mb-3 text-sm text-pm-muted">
          {error}
        </p>
      )}
      {note && (
        <p role="status" className="mb-3 text-xs text-pm-muted">
          {note}
        </p>
      )}
      <div className="space-y-4">
        {shownAgents.map((agent) => {
          const mine = accountsFor(data.accounts, agent.agent_id);
          const draft = drafts[agent.agent_id] ?? '';
          return (
            <section key={agent.agent_id} aria-label={`${agent.agent_id} sign-ins`} data-testid={`accounts-${agent.agent_id}`}>
              {!only && <h4 className="text-sm font-medium">{agentLabel(registry, agent.agent_id)}</h4>}
              {mine.length === 0 && (
                <p className="mt-0.5 text-xs text-pm-muted">
                  <CodeText text={agent.login_hint} />
                </p>
              )}
              {mine.length === 0 && <p className="mt-2 text-xs text-pm-muted">No extra sign-ins yet. It uses its own.</p>}
              <ul className="mt-2 divide-y divide-pm-border rounded-lg border border-pm-border">
                {mine.map((a) => (
                  <li key={a.id} className="flex items-center gap-2 px-3 py-2">
                    <input
                      aria-label={`Name of ${a.label}`}
                      defaultValue={a.label}
                      className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                      onBlur={(e) => {
                        const input = e.target;
                        const label = input.value.trim();
                        if (label && label !== a.label) {
                          // A rejected name (for example one already in use) goes back to the saved one.
                          void run(() => api.rename(a.id, label)).then((ok) => {
                            if (!ok) input.value = a.label;
                          });
                        } else input.value = a.label;
                      }}
                    />
                    <button
                      type="button"
                      className={BTN}
                      disabled={busy}
                      onClick={() => void run(() => api.openLoginPane(agent.agent_id, a.id), 'Opened a sign-in window. Sign in there once.')}
                    >
                      {SIGN_IN_AGAIN}
                    </button>
                    <button
                      type="button"
                      className={BTN}
                      disabled={busy}
                      title="Forgets this sign-in. Its folder is kept."
                      onClick={() => void run(() => api.remove(a.id, false))}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex items-center gap-2" data-testid={`helper-login-${agent.agent_id}`}>
                <label htmlFor={`helper-login-${agent.agent_id}`} className="text-xs text-pm-muted">
                  Run helpers on
                </label>
                <Tip text="The sign-in for a helper an agent starts without picking one. Ask me shows a card each time." label="About helper sign-ins" />
                <select
                  id={`helper-login-${agent.agent_id}`}
                  value={helperValue(data.helper_logins?.[agent.agent_id], mine)}
                  disabled={busy}
                  onChange={(e) => void run(() => api.setHelperLogin(agent.agent_id, e.target.value))}
                  className="rounded-lg border border-pm-border bg-pm-bg px-2 py-1.5 text-xs outline-none"
                >
                  <option value="ask">Ask me</option>
                  <option value="main">{SIGN_IN.defaultOne}</option>
                  {mine.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </div>
              <form
                className="mt-2 flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const label = draft.trim();
                  if (!label) return;
                  void run(async () => {
                    const created = await api.add(agent.agent_id, label);
                    setDrafts((d) => ({ ...d, [agent.agent_id]: '' }));
                    return created;
                  });
                }}
              >
                <input
                  aria-label={`New ${agent.agent_id} sign-in name`}
                  placeholder="Name, for example Work"
                  value={draft}
                  maxLength={40}
                  onChange={(e) => setDrafts((d) => ({ ...d, [agent.agent_id]: e.target.value }))}
                  className="min-w-0 flex-1 rounded-lg border border-pm-border bg-pm-bg px-3 py-1.5 text-sm outline-none"
                />
                <button type="submit" className={BTN} disabled={busy || !draft.trim()}>
                  {SIGN_IN.addAnother}
                </button>
              </form>
            </section>
          );
        })}
      </div>
    </SettingBlock>
  );
}

/** The saved choice, or "ask" when it is missing or names an account that is no longer in the list. */
function helperValue(saved: string | undefined, mine: { id: string }[]): string {
  if (saved === 'main') return 'main';
  return saved && mine.some((a) => a.id === saved) ? saved : 'ask';
}
