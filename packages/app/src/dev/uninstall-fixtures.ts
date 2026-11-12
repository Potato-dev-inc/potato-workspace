// Headless screenshots of Settings > Danger zone: a realistic plan, no real PC involved.
import type { UninstallGroup, UninstallPlan } from '../lib/uninstall';

const item = (label: string, files = 0, bytes = 0) => ({ label, path: null, bytes, files });

const group = (over: Partial<UninstallGroup> & Pick<UninstallGroup, 'id' | 'title' | 'detail' | 'size' | 'items'>): UninstallGroup => ({
  bytes: 0,
  files: 0,
  connections: 0,
  defaultOn: true,
  keepReason: null,
  ...over,
});

export const FAKE_UNINSTALL_PLAN: UninstallPlan = {
  groups: [
    group({
      id: 'program',
      title: 'The program',
      detail: 'Potato Workspace, its Start menu and desktop icons.',
      size: '412 MB',
      bytes: 432_000_000,
      files: 1_204,
      items: [item('C:\\Program Files\\Potato Workspace\\', 1_204, 432_000_000), item('Start menu and desktop shortcuts')],
    }),
    group({ id: 'autostart', title: 'Open when I sign in', detail: 'The Windows startup entry is on.', size: 'on', items: [item('Run entry: Potato Workspace')] }),
    group({
      id: 'app_data',
      title: 'App data',
      detail: 'Settings, logs and saved state, for 2 profiles.',
      size: '1.3 GB',
      bytes: 1_400_000_000,
      files: 905,
      items: [
        item('C:\\Users\\you\\AppData\\Roaming\\com.potatodev.workspace', 640),
        item('C:\\Users\\you\\AppData\\Roaming\\com.potatodev.workspace.profile-work', 120),
        item('C:\\Users\\you\\AppData\\Local\\com.potatodev.workspace (browser data)', 145),
      ],
    }),
    group({
      id: 'sign_ins',
      title: 'Agent sign-ins made here',
      detail: 'Extra logins for helper agents. You sign in again later.',
      size: '3 accounts',
      files: 18,
      items: [item('...\\accounts\\acc_3f9a12c0 - Work (claude)'), item('...\\accounts\\acc_8b21e004 - Home (codex)'), item('...\\accounts\\acc_c0de7711 - Team (claude)')],
    }),
    group({ id: 'keys', title: 'Saved keys and pairings', detail: 'Keys in Windows Credential Manager. Phones and teams unpair.', size: '14 keys', files: 14, items: [item('*.com.potatodev.workspace')] }),
    group({
      id: 'connections',
      title: 'Agent connections',
      detail: 'Only our entry. Your other agent settings stay. Backed up first.',
      size: '9 entries',
      connections: 9,
      items: [
        item('Claude Code - C:\\Users\\you\\.claude.json - potato-workspace'),
        item('Claude Code - C:\\Users\\you\\.claude.json - pm-toolbelt-fetch'),
        item('Codex - C:\\Users\\you\\.codex\\config.toml - potato-workspace'),
        item('Cursor - C:\\Users\\you\\.cursor\\mcp.json - potato-workspace'),
        item('Other tools - C:\\Users\\you\\AppData\\Roaming\\opencode\\opencode.json - potato-workspace'),
        item('C:\\Users\\you\\.claude\\skills - 4 skills'),
      ],
    }),
    group({
      id: 'projects',
      title: 'Files in your projects',
      detail: 'Our hidden folder, memory notes and git lines, in 4 projects.',
      size: '4 projects',
      bytes: 31_000_000,
      files: 88,
      items: [item('D:\\projects\\shop-site\\.potato-workspace', 41), item('D:\\projects\\notes-app\\CLAUDE.md - our block only'), item('D:\\projects\\notes-app\\.git\\info\\exclude - our lines only')],
    }),
    group({ id: 'copies', title: 'Copies and branches', detail: 'Safe copies agents worked in. Branches with no new work.', size: '4 copies', items: [item('shop-site - pm/fix-cart'), item('notes-app - pm/search-ui')] }),
    group({
      id: 'chats',
      title: 'Your chats',
      detail: 'Chat history and search. Untick it to keep them where they are, or use Keep my chats.',
      size: '82 MB',
      bytes: 82_000_000,
      files: 116,
      items: [item('...\\acp\\journals'), item('...\\chat-index.sqlite'), item('C:\\Users\\you\\PotatoWorkspace\\companions')],
    }),
    group({
      id: 'unsaved_branches',
      title: 'Branches with unsaved work',
      detail: 'Kept unless you tick this. They hold work you have not merged.',
      size: '2 copies',
      defaultOn: false,
      keepReason: 'They hold work that is not merged.',
      items: [item('shop-site - pm/new-checkout'), item('notes-app - pm/dark-mode')],
    }),
    group({
      id: 'shared_notes',
      title: 'Shared project notes',
      detail: 'memory.md and agent files. Teammates may use them in git.',
      size: '2 items',
      defaultOn: false,
      keepReason: 'Teammates may use them.',
      items: [item('D:\\projects\\shop-site\\.potato-workspace\\memory.md')],
    }),
    group({
      id: 'store_programs',
      title: 'Agent programs from the Agent Store',
      detail: 'You may use them without us.',
      size: '2 programs',
      defaultOn: false,
      keepReason: 'You may use them without Potato Workspace.',
      items: [item('claude (winget)'), item('codex (npm)')],
    }),
  ],
  cant: [
    { title: 'Windows asks once for permission', how: 'If you say no, open Settings > Apps > Potato Workspace and press Uninstall.' },
    { title: 'The relay in your Cloudflare account', how: 'Delete the worker called pm-relay and any tunnel in your Cloudflare dashboard.' },
    { title: 'Telegram and Discord bots', how: 'They belong to your own account. In Telegram, message the bot father and send /deletebot.' },
    { title: 'Branches already pushed to GitHub', how: 'Branches that start with pm/ may be on GitHub. Delete them from the repository page.' },
    { title: "The Potato app on your phone's home screen", how: 'Press and hold the icon on your phone and remove it.' },
    { title: 'Agent folder you picked: C:\\Users\\you\\.codex', how: 'Codex (Mine) uses a folder of your own, so it is kept.' },
  ],
  profiles: ['com.potatodev.workspace', 'com.potatodev.workspace.profile-work'],
  totalFiles: 2_314,
  connections: 9,
  keys: 14,
  chatsZipName: 'Potato Workspace chats 2026-11-11.zip',
  keepChatsDefault: false,
};

const FAKE_STEPS: Array<[string, string, string]> = [
  ['stop', "Stopping agents and the app's helpers", "Only the app's own programs"],
  ['backup', "Backing up your agents' settings", '6 files copied'],
  ['connections', 'Removing our entry from your agents', '9 entries removed'],
  ['projects', 'Cleaning your projects', '4 projects, 2 notes blocks removed'],
  ['autostart', 'Turning off Open when I sign in', ''],
  ['keys', 'Removing saved keys', '14 keys'],
  ['store', 'Removing agent programs from the Store', 'your agent programs stay'],
  ['sign_ins', 'Removing helper sign-ins', '3 account folders'],
  ['report', 'Writing the list of what is left', ''],
  ['handoff', 'Deleting app data and the program', ''],
];

/** Plays the run for a headless screenshot: one `uninstall://progress` event per step, then resolves. */
export async function runFakeUninstall(): Promise<void> {
  const { emit } = await import('@tauri-apps/api/event');
  const total = FAKE_STEPS.length;
  for (const [i, [step, label, detail]] of FAKE_STEPS.entries()) {
    await emit('uninstall://progress', { step, label, detail: '', state: 'running', index: i, total });
    await new Promise((r) => setTimeout(r, 450));
    await emit('uninstall://progress', { step, label, detail, state: step === 'store' ? 'skipped' : 'done', index: i, total });
  }
}
