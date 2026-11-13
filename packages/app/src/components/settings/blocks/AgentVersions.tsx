// Settings > Agents > Agent versions: is each agent a version Potato Workspace has been tested with, did
// its start-up screens still read fine the last time they were checked, and which screens did
// Potato Workspace fail to recognise. Backed by the `canary_*` commands (src-tauri/src/canary).
//
// Copy follows UX-PHASE1 §0: "Untested version" is the only chip, no code names or raw ids.
import { errorSentence } from '../../../lib/sayError';
import { useT } from '../../../i18n';
import { useCallback, useState } from 'react';
import { changeLine, lastCheckLine, tauriCanaryApi, useCanary, type CanaryApi } from '../../../lib/canary';
import { Btn, Note, SettingBlock, SettingRow, SettingToggle } from '../settings-ui';
import '../../../styles/canary.css';

/** `only`: show just this agent's line (its page in Settings > Agents), without the rows that are about every agent. */
export function AgentVersions({ api = tauriCanaryApi, now = () => Date.now(), only }: { api?: CanaryApi; now?: () => number; only?: string }) {
  const t = useT();
  const { status, refresh } = useCanary(api);
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const installed = status.agents.filter((a) => a.installed && (!only || a.agent === only));

  const check = useCallback(
    async (agent: string) => {
      setError(null);
      setRunning((cur) => new Set(cur).add(agent));
      try {
        await api.check(agent);
      } catch (e) {
        setError(errorSentence(e));
      } finally {
        setRunning((cur) => {
          const next = new Set(cur);
          next.delete(agent);
          return next;
        });
        refresh();
      }
    },
    [api, refresh],
  );

  return (
    <>
      <SettingBlock
        label={only ? t('settings.row.version.label') : t('settings.row.versions.label')}
        description={t('versions.help')}
      >
        <ul className="st-ver-list" aria-label={t('settings.row.versions.label')} data-testid="agent-versions">
          {installed.map((agent) => {
            const busy = agent.checking || running.has(agent.agent);
            const last = lastCheckLine(agent, now());
            const change = changeLine(agent, now());
            return (
              <li key={agent.agent} className="st-ver-row" data-testid={`agent-version-${agent.agent}`}>
                <div className="st-ver-main">
                  <div className="st-ver-line">
                    {!only && <span className="st-ver-name">{agent.label}</span>}
                    {agent.version && <span className="st-ver-num">{agent.version}</span>}
                    {agent.chip && (
                      <span className="st-ver-chip" data-testid={`agent-version-chip-${agent.agent}`}>
                        {agent.chip}
                      </span>
                    )}
                  </div>
                  <p className="st-ver-plain">{agent.plain}</p>
                  {change && (
                    <p className="st-ver-change" data-verdict={agent.change?.verdict} data-testid={`agent-version-change-${agent.agent}`}>
                      {change}
                    </p>
                  )}
                  {busy ? (
                    <p className="st-ver-last">{t('versions.checking')}</p>
                  ) : (
                    last && <p className="st-ver-last">{last}</p>
                  )}
                </div>
                <div className="st-ver-actions">
                  <Btn small disabled={busy} onClick={() => void check(agent.agent)}>
                    {busy ? t('versions.checkingShort') : t('versions.check')}
                  </Btn>
                </div>
              </li>
            );
          })}
          {installed.length === 0 && <li className="st-ver-plain">{only ? t('versions.notInstalled') : t('versions.none')}</li>}
        </ul>
        {error && <Note role="alert">{error}</Note>}
      </SettingBlock>
      {!only && (
        <>
          <SettingToggle
            label={t('versions.auto')}
            description={t('versions.autoHelp')}
            checked={status.auto_check}
            onChange={(on) => void api.setAuto(on).then(refresh)}
          />
          <SettingRow
            label={t('versions.screens')}
            description={
              status.captures === 0
                ? t('versions.screensNone')
                : t('versions.screensSaved', { count: status.captures })
            }
          >
            <Btn small onClick={() => void api.openCaptures().catch((e) => setError(errorSentence(e)))}>
              {t('versions.openFolder')}
            </Btn>
          </SettingRow>
        </>
      )}
    </>
  );
}
