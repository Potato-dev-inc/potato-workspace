// "Add a helper": the one door to make a standby helper. It opens beside an agent's row in the sidebar (the "+" on hover, the
// row menu, `standby.new` from What's new). Agent + Model + Enter makes one; "What it does" is optional and only gives it a
// name (with none, the helper is named "<Agent> · <model>"). Replaces the old modal dialog. Mounted once in the cockpit.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { twoTypesWording, useT, type MessageKey } from '../../i18n';
import { errorSentence } from '../../lib/sayError';
import { useAgentRegistry } from '../../lib/agentRegistry';
import { tauriModelOptionsApi, useModelOptions, type ModelOptionsApi } from '../../lib/modelOptions';
import { NEW_STANDBY_EVENT, tauriStandbyHelpersApi, useStandbyHelpers, type NewStandbyRequest, type StandbyHelpersApi, type StandbyHelpersView, type StandbyKind } from '../../lib/standbyHelpers';
import { registerAction } from '../../whatsnew/registry';
import '../../styles/standby-rows.css';
import { AgentLogo } from '../common/AgentLogo';
import { Popover } from '../common/Floating';
import { ModelPicker } from '../common/ModelPicker';

export const HELPER_RECENT_KEY = 'potato.helperRecent.v1';
const ROLES = ['reviewer', 'tester', 'researcher', 'fixer', 'docs'] as const;
type Role = (typeof ROLES)[number];

export interface RecentHelper {
  agent: string;
  model: string | null;
  /** The name it was given (a role, a typed name, or `null`: the automatic one). */
  name: string | null;
}

export function readRecentHelpers(): RecentHelper[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(HELPER_RECENT_KEY) ?? 'null');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .flatMap((p): RecentHelper[] => (p && typeof p === 'object' && typeof (p as RecentHelper).agent === 'string' ? [{ agent: (p as RecentHelper).agent, model: typeof (p as RecentHelper).model === 'string' ? (p as RecentHelper).model : null, name: typeof (p as RecentHelper).name === 'string' ? (p as RecentHelper).name : null }] : []))
      .slice(0, 2);
  } catch {
    return [];
  }
}

export function rememberHelper(next: RecentHelper): void {
  try {
    const same = (a: RecentHelper) => a.agent === next.agent && a.model === next.model && a.name === next.name;
    localStorage.setItem(HELPER_RECENT_KEY, JSON.stringify([next, ...readRecentHelpers().filter((r) => !same(r))].slice(0, 2)));
  } catch {
    // Storage is blocked: the chips just do not appear.
  }
}

/** The name a helper gets when the person picked no role: "Codex · gpt-5", or "Codex" on the default model. */
export function autoHelperName(agentLabel: string, model: string | null): string {
  return model && model.trim() ? `${agentLabel} · ${model.trim()}` : agentLabel;
}

const W = 316;

export function AddHelperPopover({
  api = tauriStandbyHelpersApi,
  modelApi = tauriModelOptionsApi,
  front,
  homeLabel,
}: {
  api?: StandbyHelpersApi;
  modelApi?: ModelOptionsApi;
  /** The agent in front: where `standby.new` (What's new) puts the helper. */
  front?: { id: string; cwd: string | null; agent: string } | null;
  /** The name an agent row shows (for "under ...") and the type of an agent pane. */
  homeLabel?: (paneId: string) => string;
}) {
  const t = useT();
  const { view, apply } = useStandbyHelpers(api);
  const registry = useAgentRegistry();
  const [req, setReq] = useState<NewStandbyRequest | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [custom, setCustom] = useState('');
  const [agent, setAgent] = useState('');
  const [model, setModel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** "Run as" picked here; `null`: the setting "A new standby is a" decides. */
  const [kindPick, setKindPick] = useState<StandbyKind | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const frontRef = useRef(front);
  frontRef.current = front;
  const [recent, setRecent] = useState<RecentHelper[]>([]);

  const show = useCallback((next: NewStandbyRequest) => {
    setReq(next);
    setRole(null);
    setCustom('');
    setAgent('');
    setModel('');
    setError(null);
    setBusy(false);
    setKindPick(null);
    setRecent(readRecentHelpers());
  }, []);
  useEffect(() => {
    const onEvent = (event: Event) => show((event as CustomEvent<NewStandbyRequest>).detail);
    window.addEventListener(NEW_STANDBY_EVENT, onEvent);
    // "Try it" in What's new: the popover for the agent in front.
    const off = registerAction('standby.new', () => {
      const f = frontRef.current;
      if (!f?.cwd) return false;
      show({ project: f.cwd, home: f.id, anchor: { x: 280, y: 160 } });
      return true;
    });
    return () => {
      window.removeEventListener(NEW_STANDBY_EVENT, onEvent);
      off();
    };
  }, [show]);
  useEffect(() => {
    if (req) addRef.current?.focus();
  }, [req]);

  const agents = useMemo(() => registry.agents.filter((a) => a.installed && a.kind !== 'shell'), [registry.agents]);
  const homeAgent = req?.home && front?.id === req.home ? front.agent : null;
  const agentId = agent || (homeAgent && agents.some((a) => a.id === homeAgent) ? homeAgent : agents[0]?.id) || '';
  const agentLabel = agents.find((a) => a.id === agentId)?.label ?? agentId;
  const options = useModelOptions(req ? agentId : null, modelApi);

  if (!req) return null;
  const atLimit = view.helpers.length >= view.max;
  const showKind = twoTypesWording();
  const kind: StandbyKind = kindPick ?? view.default_kind ?? 'spin_off';
  const roleName = custom.trim() || (role ? t(`standby.role.${role}` as MessageKey) : '');
  const name = roleName || autoHelperName(agentLabel, model);

  const create = async (input: { name: string; agent: string; model: string | null; remember: RecentHelper }) => {
    if (busy || !req.project) return;
    setBusy(true);
    setError(null);
    try {
      const next: StandbyHelpersView | null = await api.add({ name: input.name, agent: input.agent, model: input.model, project: req.project, after_task: 'wait', home: req.home, ...(showKind ? { kind } : {}) });
      apply(next);
      rememberHelper(input.remember);
      setReq(null);
    } catch (e) {
      setError(errorSentence(e));
      setBusy(false);
    }
  };
  const submit = () => {
    if (!agentId || atLimit) return;
    void create({ name, agent: agentId, model: model.trim() || null, remember: { agent: agentId, model: model.trim() || null, name: roleName || null } });
  };
  const again = (r: RecentHelper) => {
    const label = agents.find((a) => a.id === r.agent)?.label ?? r.agent;
    void create({ name: r.name ?? autoHelperName(label, r.model), agent: r.agent, model: r.model, remember: r });
  };

  const point = { x: Math.max(8, Math.min(req.anchor?.x ?? 24, window.innerWidth - W - 8)), y: Math.max(8, req.anchor?.y ?? 80) };
  const under = req.home && homeLabel ? homeLabel(req.home) : null;
  const chip = 'ah-chip';
  const on = 'is-on';
  const off = '';

  // The shared floating layer: top layer, closes through useDismissable, and the model menu inside it is a child layer,
  // so using it never counts as "outside" the card.
  return (
    <Popover
      as="form"
      point={point}
      align="start"
      label={t('standby.addTitle')}
      testId="add-helper"
      className="ah-pop grid gap-3 rounded-xl p-3 text-sm shadow-xl"
      style={{ width: W }}
      onClose={() => setReq(null)}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div>
        <div className="font-semibold">{t('standby.addTitle')}</div>
        {under && <div className="truncate text-xs ah-muted">{t('standby.addUnder', { name: under })}</div>}
      </div>
      {recent.length > 0 && !atLimit && (
        <div className="grid gap-1" data-testid="add-helper-again">
          <span className="text-xs ah-muted">{t('standby.again')}</span>
          <div className="flex flex-wrap gap-1">
            {recent.map((r) => {
              const label = agents.find((a) => a.id === r.agent)?.label ?? r.agent;
              const text = r.name ?? autoHelperName(label, r.model);
              return (
                <button key={`${r.agent}|${r.model}|${r.name}`} type="button" className={`${chip} ${off} flex items-center gap-1`} onClick={() => again(r)}>
                  <AgentLogo id={r.agent} name={label} size={12} decorative />
                  <span>{r.name && r.model ? `${r.name} · ${r.model}` : text}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      <div className="grid gap-1">
        <span className="text-xs ah-muted">{t('standby.agent')}</span>
        {agents.length === 0 ? (
          <p className="text-xs ah-muted">{t('standby.noAgents')}</p>
        ) : (
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={t('standby.agent')}>
            {agents.map((a) => (
              <button
                key={a.id}
                type="button"
                role="radio"
                aria-checked={a.id === agentId}
                className={`${chip} flex items-center gap-1 ${a.id === agentId ? on : off}`}
                onClick={() => {
                  setAgent(a.id);
                  setModel('');
                }}
              >
                <AgentLogo id={a.id} name={a.label} size={12} decorative />
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="grid gap-1">
        <span className="text-xs ah-muted">{t('standby.model')}</span>
        {agentId && <ModelPicker testId="add-helper-model" label={t('standby.model')} state={options} value={model} onChange={setModel} defaultWord={t('models.agentDefault')} />}
      </div>
      {showKind && (
        <div className="grid gap-1" data-testid="add-helper-kind">
          <span className="text-xs ah-muted">{t('standby.kind.label')}</span>
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={t('standby.kind.label')}>
            {(['spin_off', 'minion'] as const).map((k) => (
              <button key={k} type="button" role="radio" aria-checked={kind === k} className={`${chip} ${kind === k ? on : off}`} onClick={() => setKindPick(k)}>
                {t(`standby.kind.${k}` as MessageKey)}
              </button>
            ))}
          </div>
          <span className="text-xs ah-muted">{t(`standby.kind.hint.${kind}` as MessageKey)}</span>
        </div>
      )}
      <div className="grid gap-1">
        <span className="text-xs ah-muted">{t('standby.role')}</span>
        <div className="flex flex-wrap gap-1" role="group" aria-label={t('standby.role')}>
          {ROLES.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={role === r && !custom.trim()}
              className={`${chip} ${role === r && !custom.trim() ? on : off}`}
              onClick={() => {
                setRole(role === r ? null : r);
                setCustom('');
              }}
            >
              {t(`standby.role.${r}` as MessageKey)}
            </button>
          ))}
        </div>
        <input className="st-field" aria-label={t('standby.roleOwn')} placeholder={t('standby.roleOwn')} maxLength={40} value={custom} onChange={(e) => setCustom(e.target.value)} />
      </div>
      {error && (
        <p role="alert" className="text-xs ah-text">
          {error}
        </p>
      )}
      <p className="text-xs ah-muted">{atLimit ? t('standby.atLimitHere', { count: view.helpers.length }) : t('standby.addNote', { count: view.helpers.length, max: view.max })}</p>
      <div className="flex justify-end gap-2">
        <button type="button" className={`${chip} ${off}`} onClick={() => setReq(null)}>
          {t('standby.cancel')}
        </button>
        <button ref={addRef} type="submit" data-testid="add-helper-add" className={`${chip} ${on}`} disabled={atLimit || busy || !agentId}>
          {t('standby.add')}
        </button>
      </div>
    </Popover>
  );
}
