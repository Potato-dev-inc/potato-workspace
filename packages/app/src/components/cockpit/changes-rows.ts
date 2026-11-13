// Pure helpers for the Changes list rows.

/** "src/auth/login.ts" -> { dir: "src/auth/", name: "login.ts" }. The folder is shown dim, the name bright. */
export function splitPath(path: string): { dir: string; name: string } {
  const at = path.lastIndexOf('/');
  return at < 0 ? { dir: '', name: path } : { dir: path.slice(0, at + 1), name: path.slice(at + 1) };
}
