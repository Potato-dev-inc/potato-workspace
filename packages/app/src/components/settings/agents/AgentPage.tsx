// One agent's page (Settings > Agents > <agent>): everything about it in one place. The parts are the blocks the
// Agents page already had, narrowed to this agent: sign-ins, default model, how it opens, helper model, version.
// Then what the app has proof it can do, and Remove (asks first; only for an agent the person added themselves).
// The window's title already says "Agents › Claude", so nothing here repeats the name or the status.
import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';
import { terminalOnly } from '../../../lib/agentCaps';
import { removability, tauriAgentDefinitionsApi, type AgentDefinitionsApi, type DefinitionRow } from '../../../lib/agentDefinitions';
import { handleDefinitionsChanged } from '../../../lib/agentRegistry';
import { errorSentence } from '../../../lib/sayError';
import { useT } from '../../../i18n';
import { AgentLogo } from '../../common/AgentLogo';
import { AccountsGroup } from '../accounts/AccountsGroup';
import { AgentDefaultModels } from '../blocks/AgentDefaultModels';
import { AgentLaneRows } from '../blocks/AgentLaneRows';
import { AgentVersions } from '../blocks/AgentVersions';
import { HelperDefaultModels } from '../blocks/HelperModels';
import type { SettingsEnv } from '../model';
import { Btn, InfoRow, Note, SettingBlock, SettingRow } from '../settings-ui';
import { AgentNotifyRows } from '../NotifyRows';
import { openAddAgentWith } from './agentTarget';
import { CapChips } from './CapChips';
import { standingWords, type AgentRow } from './useAgentRows';
import { CodeText } from '../../common/CodeText';

/** Only an agent the person added themselves can be removed here; a built-in one or one from a project folder shows no Remove row at all. */
function removable(def: DefinitionRow | undefined, loaded: boolean): def is DefinitionRow {
  return loaded && Boolean(def) && removability(def as DefinitionRow) === 'own';
}

function RemoveRow({ row, env, api, onRemoved }: { row: AgentRow; env: SettingsEnv; api: DefinitionsPick; onRemoved: () => void }) {
  const t = useT();
  const [def, setDef] = useState<DefinitionRow | undefined>();
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .list()
      .then((listing) => {
        if (!alive) return;
        setDef(listing.definitions.find((d) => d.id === row.id && d.state !== 'shadowed'));
        setLoaded(true);
      })
      .catch(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, [api, row.id]);

  const remove = async () => {
    if (!def || !api.remove) return;
    setError(null);
    const ok = await env.confirm({
      title: t('agentPage.removeTitle', { label: row.label }),
      body: t('agentPage.removeBody', { label: row.label }),
      confirmLabel: t('settings.remove'),
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.remove(def.file);
      await handleDefinitionsChanged();
      onRemoved();
    } catch (e) {
      setError(errorSentence(e));
    } finally {
      setBusy(false);
    }
  };

  if (!removable(def, loaded)) return null;
  return (
    <>
      <SettingRow label={t('agentPage.removeLabel', { label: row.label })} description={t('agentPage.removeHelp')}>
        <Btn small disabled={busy} aria-label={t('agentPage.removeLabel', { label: row.label })} onClick={() => void remove()}>
          {t('settings.remove')}
        </Btn>
      </SettingRow>
      {error && <Note role="alert">{error}</Note>}
    </>
  );
}

type DefinitionsPick = Pick<AgentDefinitionsApi, 'list' | 'remove'>;

export interface AgentPageApis {
  definitions: DefinitionsPick;
  /** Runs the free checks of one agent again (version, hello, models). The window hears the new table by the caps event. */
  recheck?: (agentId: string) => Promise<unknown>;
}

export const defaultPageApis: AgentPageApis = {
  definitions: { list: () => tauriAgentDefinitionsApi.list(), remove: (file) => tauriAgentDefinitionsApi.remove!(file) },
  recheck: (agentId) => invoke('agent_caps_recheck', { agentId }),
};

/** Set by the app when an agent updated itself and its chat stopped answering (see `agent_caps/drift.rs`). */
function needsRepair(row: AgentRow): boolean {
  return (row.caps as (typeof row.caps & { needs_repair?: boolean }) | null)?.needs_repair === true;
}

/** The chat was turned off after an update: say why, in plain words, and offer to look again. */
function RepairNote({ row, recheck }: { row: AgentRow; recheck?: (agentId: string) => Promise<unknown> }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!needsRepair(row) || !recheck) return null;
  const again = async () => {
    setBusy(true);
    setError(null);
    try {
      await recheck(row.id);
    } catch (e) {
      setError(errorSentence(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingRow label={t('agentPage.chatOff')} description={row.caps?.chat.proof || t('agentPage.chatOffHelp', { label: row.label })}>
      <Btn small disabled={busy} aria-label={t('agentPage.checkAgainAria', { label: row.label })} onClick={() => void again()}>
        {busy ? t('agentPage.checking') : t('agentPage.checkAgain')}
      </Btn>
      {error && <Note role="alert">{error}</Note>}
    </SettingRow>
  );
}

/** "Check now" in the header: the deep check of this one agent. Hidden when the agent cannot be checked. */
function CheckNow({ row, onCheck }: { row: AgentRow; onCheck?: () => Promise<void> }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  if (!row.canTest || !row.installed || !onCheck) return null;
  return (
    <Btn
      small
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void onCheck()
          .catch(() => undefined)
          .finally(() => setBusy(false));
      }}
    >
      {busy ? t('agentPage.checking') : t('agentPage.checkNow')}
    </Btn>
  );
}

export function AgentPage({ row, env, onBack, onCheck, apis = defaultPageApis }: { row: AgentRow; env: SettingsEnv; onBack: () => void; onCheck?: () => Promise<void>; apis?: AgentPageApis }) {
  const t = useT();
  const cli = row.caps !== null && terminalOnly(row.caps);
  return (
    // A <section>: the Settings list hides a row wrapper that has no direct .st-row child, and this page holds several.
    <section className="ag-page" data-testid="agent-page" data-agent={row.id}>
      <div className="st-row ag-head">
        <span className="ag-mark">
          <AgentLogo id={row.id} name={row.label} size={28} decorative />
        </span>
        <h3 className="ag-title">{row.label}</h3>
        <span className="ag-standing" data-state={row.state} title={row.state === 'needs_login' && row.loginHint ? row.loginHint.replaceAll('`', '') : undefined}>
          {standingWords(row)}
        </span>
        <CheckNow row={row} onCheck={onCheck} />
      </div>

      <RepairNote row={row} recheck={apis.recheck} />

      <SettingBlock label={t('agentPage.canDo')} description={cli ? undefined : t('agentPage.canDoHelp')}>
        {cli ? <p className="ag-terminal-note">{t('agentPage.terminalOnly', { label: row.label })}</p> : row.caps ? <CapChips caps={row.caps} name={row.label} /> : <p className="ag-caption">{t('agentPage.nothingChecked')}</p>}
      </SettingBlock>

      {row.state === 'needs_login' && row.loginHint && <p className="ag-caption ag-hint"><CodeText text={row.loginHint} /></p>}
      <AccountsGroup only={row.id} />

      <AgentDefaultModels only={row.id} saved={env.settings.agent_default_models} onChange={(next) => void env.patch({ agent_default_models: next })} />

      {cli ? <InfoRow label={t('agentPage.howOpens')} description={t('agentPage.inTerminal')} value={t('agentPage.terminal')} /> : <AgentLaneRows only={row.id} />}

      <AgentNotifyRows agentId={row.id} label={row.label} />

      <HelperDefaultModels only={row.id} saved={env.settings.helper_default_models} onChange={(next) => void env.patch({ helper_default_models: next })} />

      {row.installed ? (
        <AgentVersions only={row.id} />
      ) : (
        <SettingRow label={t('settings.row.version.label')} description={t('keepGoing.notInstalled')}>
          <Btn small aria-label={t('agentPage.installAria', { label: row.label })} onClick={() => openAddAgentWith(row.label)}>
            {t('agentPage.install')}
          </Btn>
        </SettingRow>
      )}

      <RemoveRow row={row} env={env} api={apis.definitions} onRemoved={onBack} />
    </section>
  );
}
