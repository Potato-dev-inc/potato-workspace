// UX-4: "Claude Code" is Anthropic's product name and must not appear in any text a person reads.
// Scans every .tsx file under src for string literals and JSX text (comments are not AST literals,
// so they are skipped). Test files are excluded. Labels say "Claude" (terminal) or "Claude Agent".
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('.', import.meta.url));
const FORBIDDEN = 'Claude Code';
// The product is Potato Workspace. "Puppet Master" survives only in internal ids (binary and file names), never in
// text a person reads. A file listed here may keep the words in a rendered string; say why next to it.
const OLD_NAME = 'Puppet Master';
const OLD_NAME_ALLOWED_FILES: string[] = [];

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === '__tests__') continue;
      out.push(...tsxFiles(full));
    } else if (name.endsWith('.tsx') && !/\.test\.tsx$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

function renderedHits(file: string, phrase = FORBIDDEN): string[] {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isJsxText(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      if (node.text.includes(phrase)) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        hits.push(`${relative(SRC, file)}:${line}: ${node.text.trim().slice(0, 80)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

describe('brand: no "Claude Code" in rendered text', () => {
  it('scans src/**/*.tsx and finds no "Claude Code" in string literals or JSX text', () => {
    const files = tsxFiles(SRC);
    expect(files.length).toBeGreaterThan(50);
    const hits = files.flatMap((f) => renderedHits(f));
    expect(hits).toEqual([]);
  });
});

describe('brand: no "Puppet Master" in rendered text', () => {
  it('scans src/**/*.tsx and finds the old product name only in allowed files', () => {
    const files = tsxFiles(SRC).filter((f) => !OLD_NAME_ALLOWED_FILES.includes(relative(SRC, f).split('\\').join('/')));
    const hits = files.flatMap((f) => renderedHits(f, OLD_NAME));
    expect(hits).toEqual([]);
  });

  it('the text a person reads in lib/spaces.ts says Potato Workspace', () => {
    const text = readFileSync(join(SRC, 'lib', 'spaces.ts'), 'utf8');
    expect(text).not.toContain(OLD_NAME);
  });
});
