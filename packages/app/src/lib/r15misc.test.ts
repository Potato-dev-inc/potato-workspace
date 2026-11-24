// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { canaryText } from './canaryWords';
import { crewName } from './crewNames';
import { localizeExportPreview } from './chatExportPreview';
import { isInternalFolder } from '../components/firstrun/StepProject';
import { watchedRows } from '../components/firstrun/StepAgents';
import { chipWord } from '../components/chat/chipWords';
import { formatDuration } from './standby';
import { useChinese, useEnglish } from '../i18n/test-utils';
import type { AgentHealth } from './agent-health';

beforeEach(() => useEnglish());

describe('welcome', () => {
  it('leaves out the doctor, side-question, temp and app-data folders but not a real project', () => {
    for (const p of ['C:\\Users\\a\\AppData\\Local\\Temp\\potato-workspace-doctor', 'C:\\Users\\a\\AppData\\Roaming\\com.potatodev.workspace\\side-question', '/tmp/x']) expect(isInternalFolder(p)).toBe(true);
    for (const p of ['D:\\work\\app', 'C:\\Users\\a\\Documents\\temp-notes']) expect(isInternalFolder(p)).toBe(false);
  });
  it('shows a remembered "needs sign-in" for an unchecked agent, like Settings does', () => {
    const row = { id: 'cursor_agent', label: 'Cursor', state: 'unchecked', installed: true } as AgentHealth;
    expect(watchedRows([row], { cursor_agent: { state: 'needs_login', reason: '', at: 1 } })[0].state).toBe('needs_login');
    expect(watchedRows([row], {})[0].state).toBe('unchecked');
  });
});

describe('Traditional Chinese leftovers', () => {
  it('says the version-card sentence, effort, durations and crew names in Chinese', () => {
    useChinese();
    expect(canaryText('Codex 0.167.1 changed its screens. Potato Workspace will ask you before acting.')).toContain('Codex 0.167.1');
    expect(canaryText('Codex 0.167.1 changed its screens. Potato Workspace will ask you before acting.')).not.toMatch(/changed/);
    expect(chipWord('Extra')).toBe('特高');
    expect(formatDuration(252_000)).toBe('4 分 12 秒');
    expect(crewName({ slug: 'template:our-way', name: 'Our way' })).not.toBe('Our way');
    const html = '<div class="tool"><span class="name">edit</span> <span>File u1.txt</span></div><p class="notice">Create File U1.txt</p>';
    const out = localizeExportPreview(html, 'page');
    expect(out).toContain('編輯');
    expect(out).toContain('建立檔案 U1.txt');
  });
  it('English stays as it is', () => {
    expect(formatDuration(252_000)).toBe('4m 12s');
    expect(crewName({ slug: 'template:our-way', name: 'Our way' })).toBe('Our way');
  });
});
