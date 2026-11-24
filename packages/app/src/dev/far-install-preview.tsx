import { useMemo } from 'react';
import { FarInstallSheet } from '../components/devices/FarInstallSheet';
import { ALL_CAPS, type Host } from '../lib/host/host';

// P6.2 + P6.3: the "Install <agent> on <PC>?" sheet as the cockpit shows it, over a fake far PC (example data only, no real PC). `fail`: every
// install try ends with an error, so the sheet ends in the hand-over (a far shell with the command, the page and Done); the shell's screen is a
// scripted banner, drawn by the real terminal viewport through the same far pane verbs a real far PC answers.
const STEP = {
  index: 0,
  label: 'Codex',
  tool: null,
  method: 'npm',
  command: 'npm install -g --prefix /home/pm/.local @openai/codex',
  source: 'https://developers.openai.com/codex/quickstart',
  source_host: 'developers.openai.com',
  high_risk: false,
  note: '',
};
const PLAN = { agent_id: 'codex', label: 'Codex', available: true, reason: null, hint: null, steps: [STEP] };
const SCREEN = 'pm@linux-box:~/app$ \r\n';

function farHost(fail: boolean): Host {
  let runs = 0;
  return {
    place: { kind: 'pc', node: 'n1', name: 'Linux Box' },
    live: true,
    caps: ALL_CAPS,
    listen: (async () => () => undefined) as Host['listen'],
    invoke: (async (cmd: string) => {
      switch (cmd) {
        case 'agents_install_plan':
          return PLAN;
        case 'agents_install_run':
          return { pane_id: `run${++runs}`, command: STEP.command, label: 'Codex' };
        case 'agents_install_status':
          return { known: true, done: true, exit_code: fail ? 1 : 0, message: 'The install did not finish.' };
        case 'agents_install_finish':
          return { path_added: [], health: { installed: false }, needs_restart: false };
        case 'project_recent':
          return [{ path: 'remote:abc', name: 'app' }];
        case 'spawn_pane':
          return 'shell1';
        case 'list_panes':
          return [{ id: 'shell1', agent_type: 'shell', status: 'running', pid: 1, created_at: 0, last_output_at: null, cwd: 'app', cols: 80, rows: 12 }];
        case 'read_pane_screen_replay':
          return { data: [...new TextEncoder().encode(SCREEN)], cols: 80, rows: 12, offset: 0 };
        case 'read_pane_raw_buffer':
          return [];
        default:
          return null;
      }
    }) as Host['invoke'],
  };
}

export function FarInstallPreview({ fail }: { fail: boolean }) {
  const host = useMemo(() => farHost(fail), [fail]);
  return (
    <div className="cockpit" style={{ position: 'fixed', inset: 0, zIndex: 500, background: 'var(--bg)', color: 'var(--label)' }}>
      <FarInstallSheet request={{ host, agentId: 'codex', finish: () => undefined }} />
    </div>
  );
}
