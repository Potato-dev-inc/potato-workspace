/** The page a phone sees when the PC is offline. No external assets. Retries by itself every 10 seconds. */
export const OFFLINE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="10">
<title>PC offline</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#161616;color:#e8e8e8;font:16px/1.5 system-ui,sans-serif}
  main{max-width:22rem;padding:1.5rem;text-align:center}
  p{color:#a0a0a0;margin:.5rem 0 0;font-size:.9rem}
</style></head>
<body><main>
<h1 style="font-size:1.1rem;margin:0">Your PC is offline or Potato Workspace is closed.</h1>
<p>This page will retry.</p>
</main></body></html>`;

export function offlineResponse(): Response {
  return new Response(OFFLINE_HTML, {
    status: 503,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "retry-after": "10" },
  });
}
