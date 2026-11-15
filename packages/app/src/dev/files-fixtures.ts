// The project folder for the harness: what the mocked `files_*` commands answer. Example data only.
// The shapes are `lib/files-api.ts` (the Rust views in src-tauri/src/files).

import { CSV_SAMPLE, DOCX_SAMPLE, PDF_SAMPLE, XLSX_TWO_SHEETS } from '../components/files/office-fixtures';
import { bytesOf } from '../lib/files-api';

const dir = (path: string) => ({ name: path.slice(path.lastIndexOf('/') + 1), path, isDir: true, size: 0 });
const file = (path: string, size = 900) => ({ name: path.slice(path.lastIndexOf('/') + 1), path, isDir: false, size });

const TREE: Record<string, { entries: ReturnType<typeof file>[]; truncated: boolean }> = {
  '.github': { truncated: false, entries: [file('.github/ci.yml', 500)] },
  '': { truncated: false, entries: [dir('.github'), dir('docs'), dir('node_modules'), dir('src'), dir('tests'), file('.gitignore', 60), file('Cargo.toml', 300), file('README.md'), file('package.json', 420), file('logo.png', 5200), file('plan.docx', 2900), file('shop.xlsx', 7000), file('people.csv', 70), file('paper.pdf', 600)] },
  src: { truncated: false, entries: [dir('src/billing'), file('src/auth.ts', 1400), file('src/index.ts', 300), file('src/session.ts', 2100), file('src/tokens.ts', 800)] },
  'src/billing': { truncated: false, entries: [file('src/billing/invoice.ts', 1800), file('src/billing/plans.ts', 700)] },
  docs: { truncated: false, entries: [file('docs/setup.md', 1200)] },
  tests: { truncated: false, entries: [file('tests/auth.test.ts', 1500)] },
};

const AUTH = `import { signToken, verifyToken } from './tokens';
import type { Session } from './session';

const MAX_AGE_MS = 15 * 60 * 1000; // a session lasts 15 minutes

/** Signs a person in and returns their session. */
export async function signIn(email: string, password: string): Promise<Session> {
  if (!email.includes('@')) {
    throw new Error('That email address does not look right.');
  }
  const user = await findUser(email);
  if (!user || !(await user.checks(password))) {
    throw new Error('Wrong email or password.');
  }
  return { user: user.id, token: signToken(user.id), expires: Date.now() + MAX_AGE_MS };
}

export function isValid(session: Session): boolean {
  return session.expires > Date.now() && verifyToken(session.token);
}
`;

const README = `# Billing service

A small service that signs people in and sends them invoices.

## Run it

1. Install the packages with \`npm install\`.
2. Start it with \`npm start\`.

## Good to know

- A session lasts **15 minutes**.
- Invoices are made on the first day of the month.
`;

const PATCH = [
  'diff --git a/src/auth.ts b/src/auth.ts',
  'index 3a1f..9c2d 100644',
  '--- a/src/auth.ts',
  '+++ b/src/auth.ts',
  '@@ -3,5 +3,5 @@ import type { Session } from "./session";',
  ' ',
  '-const MAX_AGE_MS = 60 * 60 * 1000;',
  '+const MAX_AGE_MS = 15 * 60 * 1000; // a session lasts 15 minutes',
  ' ',
  ' /** Signs a person in and returns their session. */',
  '@@ -9,3 +9,6 @@ export async function signIn(email: string, password: string) {',
  '+  if (!email.includes("@")) {',
  '+    throw new Error("That email address does not look right.");',
  '+  }',
  '   const user = await findUser(email);',
  '   if (!user || !(await user.checks(password))) {',
].join('\n');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export function filesMock(cmd: string, args: Record<string, unknown>): { handled: boolean; value?: unknown } {
  if (!cmd.startsWith('files_')) return { handled: false };
  const path = String(args.path ?? '');
  switch (cmd) {
    case 'files_list':
      return { handled: true, value: TREE[path] ?? { entries: [], truncated: false } };
    case 'files_marks':
      return { handled: true, value: [{ path: 'src/auth.ts', mark: 'M' }, { path: 'src/tokens.ts', mark: 'M' }, { path: 'src/billing/plans.ts', mark: 'N' }, { path: 'docs/setup.md', mark: 'M' }] };
    case 'files_diff':
      return { handled: true, value: path === 'src/auth.ts' ? PATCH : '' };
    case 'files_read_bytes': {
      const name = path.slice(path.lastIndexOf('/') + 1);
      const base64 = path.endsWith('.docx') ? DOCX_SAMPLE : path.endsWith('.xlsx') ? XLSX_TWO_SHEETS : path.endsWith('.csv') ? CSV_SAMPLE : PDF_SAMPLE;
      return { handled: true, value: { path, name, size: base64.length, kind: 'bytes', base64 } };
    }
    case 'files_open_bytes': {
      // A scenario sets `__pmBigFile` ({ url, size }) to open a big file streamed from a test server; the other files are
      // the small samples, served from a blob address (a worker can fetch it, like the app's own stream address).
      const name = path.slice(path.lastIndexOf('/') + 1);
      const big = (globalThis as { __pmBigFile?: { url: string; size: number; tooLarge?: boolean } }).__pmBigFile;
      if (big && path.startsWith('big')) return { handled: true, value: { path, name, size: big.size, kind: big.tooLarge ? 'too_large' : 'stream', limit: 500 * 1024 * 1024, url: big.url } };
      // A scenario can set `__pmFileBase64` ({ path: base64 }) to open its own Word or Excel file.
      const custom = (globalThis as { __pmFileBase64?: Record<string, string> }).__pmFileBase64?.[path];
      const base64 = custom ?? (path.endsWith('.docx') ? DOCX_SAMPLE : path.endsWith('.xlsx') ? XLSX_TWO_SHEETS : path.endsWith('.csv') ? CSV_SAMPLE : PDF_SAMPLE);
      const url = URL.createObjectURL(new Blob([bytesOf(base64) as BlobPart]));
      return { handled: true, value: { path, name, size: base64.length, kind: 'stream', limit: 500 * 1024 * 1024, url } };
    }
    case 'files_write': {
      // A scenario sets `__pmDiskChanged` to show the "changed on disk" bar.
      if ((globalThis as { __pmDiskChanged?: boolean }).__pmDiskChanged && args.overwrite !== true) throw new Error('FILES_CONFLICT: The file changed on disk since you opened it.');
      return { handled: true, value: { path, size: String(args.text ?? '').length, version: 'v2' } };
    }
    case 'files_search_cancel':
      return { handled: true, value: null };
    case 'files_search_contents': {
      const q = String(args.query ?? '').toLowerCase();
      const lines = AUTH.split('\n');
      const hits = lines.flatMap((text, i) => {
        const at = q ? text.toLowerCase().indexOf(q) : -1;
        return at < 0 ? [] : [{ path: 'src/auth.ts', name: 'auth.ts', line: i + 1, text: text.trim(), start: at - (text.length - text.trimStart().length), end: at - (text.length - text.trimStart().length) + q.length }];
      });
      return { handled: true, value: { hits, truncated: false, cancelled: false, filesScanned: 12 } };
    }
    case 'files_open_default':
    case 'files_reveal':
      return { handled: true, value: null };
    case 'files_read': {
      const name = path.slice(path.lastIndexOf('/') + 1);
      if (path.endsWith('.png')) return { handled: true, value: { path, name, size: 5200, kind: 'image', text: null, dataUrl: PNG } };
      const text = path === 'README.md' || path.endsWith('.md') ? README : AUTH;
      return { handled: true, value: { path, name, size: text.length, kind: 'text', text, dataUrl: null, version: 'v1' } };
    }
    default:
      return { handled: false };
  }
}
