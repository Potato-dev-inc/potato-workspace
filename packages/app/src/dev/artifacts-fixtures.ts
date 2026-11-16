// What the mocked `artifacts_*` commands answer in the harness: one page the agent made, in two versions. Example data only.
const PAGE_V2 = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Sign-in report</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; color: #1c1c1e; margin: 0; padding: 28px 32px; background: #fff; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  p.sub { color: #6b6b70; margin: 0 0 22px; }
  .row { display: flex; align-items: center; gap: 10px; margin: 8px 0; }
  .row b { width: 120px; font-weight: 500; }
  .bar { height: 18px; border-radius: 4px; background: #3a3a3f; }
  .n { color: #6b6b70; font-variant-numeric: tabular-nums; }
  .note { margin-top: 24px; padding: 12px 14px; border: 1px solid #dcdce0; border-radius: 8px; background: #f6f6f8; }
</style></head>
<body>
  <h1>Sign-in problems, last 7 days</h1>
  <p class="sub">Made by the agent from the server log. The bars are drawn by a small script.</p>
  <div id="chart"></div>
  <div class="note"><b>What changed:</b> the redirect waits for the profile, so the blank page is gone. Expired sessions go back to the form.</div>
  <script>
    var data = [['Blank page', 41], ['Expired session', 23], ['Wrong password', 12], ['Slow profile', 7]];
    var max = 41, host = document.getElementById('chart');
    data.forEach(function (row) {
      var el = document.createElement('div'); el.className = 'row';
      el.innerHTML = '<b>' + row[0] + '</b><div class="bar" style="width:' + (row[1] / max * 260) + 'px"></div><span class="n">' + row[1] + '</span>';
      host.appendChild(el);
    });
  </script>
</body></html>`;

const PAGE_V1 = PAGE_V2.replace('Sign-in problems, last 7 days', 'Sign-in problems (draft)');

/** A small drawn picture standing in for the screenshot of the page area (example data only). */
const PICTURE =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="240" viewBox="0 0 360 240"><rect width="360" height="240" fill="#fff"/><rect x="16" y="16" width="200" height="14" rx="3" fill="#3a3a3f"/><rect x="16" y="48" width="120" height="12" rx="3" fill="#3a3a3f"/><rect x="16" y="72" width="260" height="12" rx="3" fill="#3a3a3f"/><rect x="16" y="100" width="150" height="120" rx="6" fill="#f6f6f8" stroke="#dcdce0"/><ellipse cx="90" cy="150" rx="80" ry="40" fill="none" stroke="#e8590c" stroke-width="4"/><circle cx="14" cy="104" r="9" fill="#e8590c"/><text x="14" y="108" font-size="11" font-weight="700" text-anchor="middle" fill="#fff">1</text></svg>',
  );

export const SAMPLE_ARTIFACT = {
  id: 'signin-report',
  title: 'Sign-in report',
  kind: 'html' as const,
  createdAt: '2026-11-15T09:00:00.000Z',
  updatedAt: '2026-11-15T09:20:00.000Z',
  versions: [
    { n: 1, at: '2026-11-15T09:00:00.000Z', bytes: PAGE_V1.length },
    { n: 2, at: '2026-11-15T09:20:00.000Z', bytes: PAGE_V2.length },
  ],
};

export function artifactsMock(cmd: string, args: Record<string, unknown>): { handled: boolean; value?: unknown } {
  switch (cmd) {
    case 'artifacts_sync':
      return { handled: true, value: [SAMPLE_ARTIFACT] };
    case 'artifacts_read': {
      const version = typeof args.version === 'number' ? args.version : 2;
      return { handled: true, value: { artifact: SAMPLE_ARTIFACT, version, content: version === 1 ? PAGE_V1 : PAGE_V2, path: `C:/work/shop/.potato/artifacts/signin-report/v${version}.html` } };
    }
    case 'artifacts_open_in_agent_browser':
    case 'markup_less_motion':
    case 'markup_send':
      return { handled: true, value: null };
    case 'markup_targets':
      return {
        handled: true,
        value: {
          current: 'pane-claude-1',
          rows: [
            { id: 'pane-claude-1', agentId: 'claude', name: 'Claude', task: 'Sign-in report', project: 'shop', status: 'working', ok: true, reason: null },
            { id: 'pane-codex-1', agentId: 'codex', name: 'Codex', task: '', project: 'shop', status: 'waiting', ok: true, reason: null },
            { id: 'pane-gemini-1', agentId: 'gemini', name: 'Gemini', task: 'Docs pass', project: 'blog', status: 'idle', ok: true, reason: null },
            { id: 'pane-kimi-1', agentId: 'kimi', name: 'Kimi', task: '', project: 'blog', status: 'waiting', ok: false, reason: 'It is waiting on a question.' },
          ],
        },
      };
    case 'markup_capture':
      return { handled: true, value: { shotId: 'mk-demo', thumb: PICTURE } };
    case 'artifacts_open_in_browser':
      return { handled: true, value: null };
    case 'artifacts_share_make':
      return { handled: true, value: { link: 'https://potato-stable-link.example.workers.dev/bridge/share/q3Zk8mWc1Yt0vRnB5xJdLg7aPe2uHsFo', version: 2, expiresAt: Date.parse('2026-11-16T09:20:00.000Z') } };
    case 'artifacts_share_list':
      return { handled: true, value: [] };
    case 'artifacts_share_stop':
      return { handled: true, value: 1 };
    case 'artifacts_pop_out':
      return { handled: true, value: null };
    default:
      return { handled: false };
  }
}
