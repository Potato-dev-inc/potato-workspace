// One file, however an agent spells it: "u1.txt", "./u1.txt", "file:///u1.txt" and "/home/me/gp1/u1.txt" are the same file. The chat's "Edited N files",
// its price line, the Outputs list and (in Rust, `distinct_files`) the turn ending all count a file once through this rule. A loose spelling (relative,
// or one name under "/") folds into the full path it ends.
const norm = (p: string): string => p.replace(/^file:\/\//i, '').replace(/\\/g, '/').replace(/^\/(?=[a-zA-Z]:)/, '').replace(/^(\.\/)+/, '');
const isAbs = (p: string): boolean => /^([a-zA-Z]:)?\//.test(p);
/** A spelling that names no folder of its own: "u1.txt", "src/a.ts", "/u1.txt". */
const isLoose = (p: string): boolean => !isAbs(p) || /^\/[^/]+$/.test(p);

/** Each given path -> the path it counts as (itself, or the full spelling it is the tail of). Case matters (Linux). */
export function canonPaths(paths: Iterable<string>): Map<string, string> {
  const raws = [...new Set(paths)];
  const full = raws.filter((p) => !isLoose(norm(p)));
  const byNorm = new Map<string, string>();
  const out = new Map<string, string>();
  for (const raw of raws) {
    const n = norm(raw);
    const tail = `/${n.replace(/^\//, '')}`;
    const home = isLoose(n) ? full.find((a) => norm(a).endsWith(tail)) : null;
    const canon = home ?? byNorm.get(n) ?? raw;
    byNorm.set(n, canon);
    out.set(raw, canon);
  }
  return out;
}

/** The paths with each file once (the first spelling of it wins; a loose one gives way to its full twin). */
export function distinctPaths(paths: Iterable<string>): string[] {
  return [...new Set(canonPaths(paths).values())];
}
