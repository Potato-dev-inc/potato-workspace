// What each row says about its saved values, kept in one place (the rows live in many section files, some owned
// by other work): the keys it owns (for the Changed dot, Reset and Undo), how its value reads in words (the Undo
// toast), and a small preview drawn under its control. `withRowMeta` lays this over the rows once, in catalog.ts.
//
// A row that is an action, a list or a panel has no entry: it never shows a dot, a Reset or an Undo. Key fields,
// sign-ins, pairing and danger rows must stay out of this table. `copy.guard.test.ts` pins every entry.
import type { Settings } from '@potato-workspace/shared';
import { t } from '../../i18n';
import { parseSwitchStyle, parseWindowLayout } from '../../lib/mode-switch/model';
import { styleLabel, windowLayoutLabel } from './i18n-labels';
import { HANDOFF_MODES } from './blocks/QuickHandoffRows';
import type { RowDef } from './model';
import { RowCopyContext } from './settings-ui';
import { ModeSwitchFrame, UsageSample } from './previews/Previews';
import { awayWords } from './sections/GeneralSection';

interface Meta {
  keys: (keyof Settings)[];
  valueText?: RowDef['valueText'];
  preview?: RowDef['preview'];
}

const turnsWords = (n: number | undefined): string => (!n ? t('settings.value.noLimit') : t('settings.value.turnsUnit', { count: n }));
const minutesWords = (n: number | undefined): string => (!n ? t('settings.value.noLimit') : t('settings.value.minUnit', { count: n }));

const themeLabel = (theme: Settings['theme'] | undefined): string =>
  theme === 'light' ? t('lookFeel.theme.light') : theme === 'dim' ? t('lookFeel.theme.dim') : theme === 'auto' ? t('lookFeel.theme.auto') : t('lookFeel.theme.dark');

export const ROW_META: Record<string, Meta> = {
  theme: { keys: ['theme'], valueText: (s) => t('settings.value.theme', { value: themeLabel(s.theme) }) },
  'mode-switch-animation': {
    keys: ['mode_switch_animation'],
    valueText: (s) => t('settings.value.modeSwitch', { value: styleLabel(parseSwitchStyle(s.mode_switch_animation)) }),
    preview: (env) => <ModeSwitchFrame style={env.settings.mode_switch_animation} />,
  },
  'individual-window-layout': {
    keys: ['individual_window_layout'],
    valueText: (s) => t('settings.value.windowLayout', { value: windowLayoutLabel(parseWindowLayout(s.individual_window_layout)) }),
  },
  'usage-bar': {
    keys: ['show_usage_bar'],
    preview: (env) => (env.settings.show_usage_bar ?? true ? <UsageSample /> : null),
  },
  'usage-login-reads': { keys: ['usage_login_reads'] },
  'your-name': { keys: ['display_name'], valueText: (s) => t('settings.value.yourName', { value: s.display_name ? s.display_name : t('settings.value.empty') }) },
  'confirm-close': { keys: ['confirm_close_running_pane'] },
  'close-to-tray': { keys: ['close_to_tray'] },
  'keep-awake': { keys: ['keep_awake_while_working'] },
  'away-minutes': { keys: ['away_minutes'], valueText: (s) => t('settings.value.away', { value: awayWords(s.away_minutes ?? 5) }) },
  checkpoints: { keys: ['checkpoints_enabled'] },
  'budget-turns': { keys: ['budget_default_turns'], valueText: (s) => t('settings.value.turns', { value: turnsWords(s.budget_default_turns) }) },
  'right-size': { keys: ['right_size_suggest'] },
  'handoff-mode': {
    keys: ['handoff_mode'],
    valueText: (s) => t('settings.value.handoff', { value: HANDOFF_MODES.find((m) => m.value === s.handoff_mode)?.label ?? HANDOFF_MODES[0].label }),
  },
  'helper-tools': { keys: ['pane_mcp_enabled'] },
  'live-updates': { keys: ['agent_hooks_mode'], valueText: (s) => t('settings.value.liveUpdates', { value: s.agent_hooks_mode === 'off' ? t('settings.value.off') : t('settings.value.watchOnly') }) },
  'rust-mcp': { keys: ['developer_use_rust_mcp'] },
  'librarian-indexer': { keys: ['librarian_indexer_path'] },
  'opencode-provider': { keys: ['opencode_model_provider'] },
  'opencode-model': { keys: ['opencode_model_id'] },
  'simple-mode': { keys: ['simple_mode'] },
  missions: { keys: ['missions_enabled'] },
  'night-shift': { keys: ['night_shift_enabled'] },
  'show-terminals': { keys: ['show_terminals'] },
  'helper-answers': { keys: ['helper_answers_enabled'] },
  'model-bridge': { keys: ['model_bridge_enabled'] },
  'spaces-labs': { keys: ['spaces_enabled'] },
  'lend-labs': { keys: ['lend_enabled'] },
  'devices-labs': { keys: ['devices_enabled'] },
  'far-pcs-labs': { keys: ['far_pcs_enabled'] },
  'ssh-chat-labs': { keys: ['ssh_chat_enabled'] },
  'pcdoor-labs': { keys: ['pcdoor_enabled'] },
  'account-labs': { keys: ['account_enabled'] },
  'desktop-potato-labs': { keys: ['desktop_pet_enabled'] },
  'agent-browser-labs': { keys: ['agent_browser_enabled'] },
  'companion-vault-labs': { keys: ['companion_vault_enabled'] },
  'discord-bot-labs': { keys: ['discord_bot_enabled'] },
  'project-guide-labs': { keys: ['project_guide_enabled'] },
  'markup-bar-labs': { keys: ['markup_bar_enabled'] },
  'dock-browser-labs': { keys: ['dock_browser_enabled'] },
  'timeline-labs': { keys: ['timeline_day_enabled'] },
  'smaller-updates-labs': { keys: ['smaller_updates_enabled'] },
  'crews-labs': { keys: ['crews_enabled'] },
  'workflows-labs': { keys: ['workflows_enabled'] },
  'workflow-reply-labs': { keys: ['workflow_reply_style'] },
  'opentunnel-labs': { keys: ['opentunnel_stable_link'] },
  'early-versions': { keys: ['early_versions_enabled'] },
  'show-developer-settings': { keys: ['show_developer_settings'] },
};

/**
 * Copy for rows defined in a file this change does not own (Agents): the new label and hint, and the label the row
 * draws today. Every other row's words are edited where the row is defined.
 */
const COPY_FOR_OTHER_FILES: Record<string, { from: string; label: string; hint: string }> = {
  'helper-tools': { from: 'Potato tools in every agent', label: 'Potato tools in every agent', hint: 'Agents you open here get the Potato tools with no setup.' },
  'live-updates': { from: 'Live updates', label: 'Live updates', hint: 'Claude and Codex tell the app when they start, ask and finish.' },
};

/** The rows with their keys, value text and preview filled in from `ROW_META`, and the copy table applied. A row of its own keeps what it declares. */
export function withRowMeta(rows: RowDef[]): RowDef[] {
  return rows.map((row) => {
    const meta = ROW_META[row.id];
    const copy = COPY_FOR_OTHER_FILES[row.id];
    let next = meta ? { ...row, keys: row.keys ?? meta.keys, valueText: row.valueText ?? meta.valueText, preview: row.preview ?? meta.preview } : row;
    if (copy) {
      const render = next.render;
      next = {
        ...next,
        label: copy.label,
        hint: copy.hint,
        labs: next.labs ? { ...next.labs, name: copy.label, about: copy.hint } : undefined,
        render: (env) => <RowCopyContext.Provider value={copy}>{render(env)}</RowCopyContext.Provider>,
      };
    }
    return next;
  });
}
