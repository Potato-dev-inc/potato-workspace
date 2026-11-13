// The project folder for the harness: what the mocked `files_*` commands answer. Example data only.
// The shapes are `lib/files-api.ts` (the Rust views in src-tauri/src/files).

const dir = (path: string) => ({ name: path.slice(path.lastIndexOf('/') + 1), path, isDir: true, size: 0 });
const file = (path: string, size = 900) => ({ name: path.slice(path.lastIndexOf('/') + 1), path, isDir: false, size });

const TREE: Record<string, { entries: ReturnType<typeof file>[]; truncated: boolean }> = {
  '': { truncated: false, entries: [dir('docs'), dir('src'), dir('tests'), file('README.md'), file('package.json', 420), file('logo.png', 5200)] },
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
    case 'files_reveal':
      return { handled: true, value: null };
    case 'files_read': {
      const name = path.slice(path.lastIndexOf('/') + 1);
      if (path.endsWith('.png')) return { handled: true, value: { path, name, size: 5200, kind: 'image', text: null, dataUrl: PNG } };
      const text = path === 'README.md' || path.endsWith('.md') ? README : AUTH;
      return { handled: true, value: { path, name, size: text.length, kind: 'text', text, dataUrl: null } };
    }
    default:
      return { handled: false };
  }
}
