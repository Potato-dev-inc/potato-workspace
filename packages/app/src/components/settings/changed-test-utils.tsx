// A small catalog for the screen tests of the Changed dot, Reset, the filter and the Undo toast. The real panel
// renders it; the rows are tiny but have the real shapes (a switch, a number, a text, a danger row, a key field).
import type { SectionDef, SettingsEnv } from './model';
import { NumberControl, SecretControl, TextControl } from './controls';
import { Btn, SettingRow, SettingToggle } from './settings-ui';

export function testSections(): SectionDef[] {
  const page = (id: SectionDef['id'], title: string, rows: SectionDef['rows'] = []): SectionDef => ({ id, title, blurb: `${title}.`, rows });
  return [
    page('overview', 'Overview', [{ id: 'setup-check', label: 'Check my setup', hint: 'What works.', level: 'basic', group: 'Setup', render: () => <SettingRow label="Check my setup" /> }]),
    page('agents', 'Agents'),
    page('helpers', 'Helpers'),
    page('look', 'Look and feel', [
      {
        id: 'theme',
        label: 'Theme',
        hint: 'Dark or light.',
        level: 'basic',
        group: 'Appearance',
        keys: ['theme'],
        valueText: (s) => `Theme: ${s.theme === 'light' ? 'Light' : 'Dark'}`,
        render: (env: SettingsEnv) => (
          <SettingToggle label="Light theme" description="Dark or light." checked={env.settings.theme === 'light'} onChange={(on) => void env.patch({ theme: on ? 'light' : 'dark' })} />
        ),
      },
      {
        id: 'away',
        label: 'Away digest after',
        hint: 'Minutes.',
        level: 'basic',
        group: 'Appearance',
        keys: ['away_minutes'],
        valueText: (s) => `Away digest: ${s.away_minutes ?? 5} minutes`,
        render: (env: SettingsEnv) => (
          <SettingRow label="Away digest after">
            <NumberControl aria-label="Away" min={0} max={1440} value={env.settings.away_minutes ?? 5} onCommit={(n) => env.patch({ away_minutes: n })} />
          </SettingRow>
        ),
      },
      {
        id: 'name',
        label: 'Your name',
        hint: 'For the greeting.',
        level: 'basic',
        group: 'Appearance',
        keys: ['display_name'],
        valueText: (s) => `Your name: ${s.display_name || 'Empty'}`,
        render: (env: SettingsEnv) => (
          <SettingRow label="Your name">
            <TextControl aria-label="Name" mode="blur" value={env.settings.display_name ?? ''} onCommit={(v) => env.patch({ display_name: v || null })} />
          </SettingRow>
        ),
      },
      {
        id: 'folder',
        label: 'Default project folder',
        hint: 'Where panes start.',
        level: 'basic',
        group: 'Appearance',
        render: (env: SettingsEnv) => (
          <SettingToggle label="Folder is set" description="Where panes start." checked={Boolean(env.settings.project_path)} onChange={(on) => void env.patch({ project_path: on ? 'C:\\work' : null })} />
        ),
      },
      {
        id: 'wipe',
        label: 'Wipe checkpoints',
        hint: 'Cannot be undone.',
        level: 'basic',
        group: 'Danger',
        danger: true,
        keys: ['checkpoints_keep'],
        render: (env: SettingsEnv) => (
          <SettingRow label="Wipe checkpoints">
            <Btn onClick={() => void env.patch({ checkpoints_keep: 5 })}>Wipe</Btn>
          </SettingRow>
        ),
      },
    ]),
    page('connect', 'Connect'),
    page('keys', 'Keys', [
      {
        id: 'key-anthropic',
        label: 'Anthropic API key',
        hint: 'Kept in the keychain.',
        level: 'basic',
        group: 'Provider keys',
        render: (env: SettingsEnv) => (
          <SettingRow label="Anthropic API key">
            <SecretControl aria-label="Key" onCommit={(secret) => env.patch({ anthropic_api_key: secret })} />
          </SettingRow>
        ),
      },
    ]),
    page('shortcuts', 'Shortcuts'),
    page('advanced', 'Advanced'),
  ];
}
