// The words people read follow lib/glossary.ts: sign in (not login or account), chat (not ACP), Potato Workspace
// (not Puppet Master). Scans the text a component draws (JSX text, and labels, hints, titles, aria-labels and
// placeholders), modelled on brand-labels.test.ts. Comments, imports, class names, ids and search keywords are
// not rendered, so they are skipped.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { ownStrings as firstRunStrings } from '../components/firstrun/copy';
import { ownStrings as simpleStrings } from '../components/simple/copy';
import { BANNED_TERMS, RUN_WAYS, SIGN_IN, TERMS } from './glossary';

const SRC = fileURLToPath(new URL('..', import.meta.url));

/** Screens about agents, where login and account must read "sign in". Add a file here when it is clean. */
const AGENT_SCREENS = [
  'components/firstrun/',
  'components/simple/',
  'components/cockpit/QuestionCard.tsx',
  'components/cockpit/Inbox.tsx',
  'components/cockpit/SidebarFooter.tsx',
  'components/settings/sections/AgentsSection.tsx',
  'components/settings/sections/BridgeSection.tsx',
  'components/settings/blocks/AgentDefinitions.tsx',
  'components/settings/accounts/AccountsGroup.tsx',
  'components/settings/blocks/AgentLaneRows.tsx',
  'components/settings/blocks/AgentWizard.tsx',
  'components/settings/blocks/AddChatDialog.tsx',
  'components/settings/blocks/AcpStep.tsx',
  'components/settings/sections/GeneralSection.tsx',
  'components/cockpit/PaneView.tsx',
  'components/cockpit/NewAgentMenu.tsx',
  'components/cockpit/night/PlansPicker.tsx',
  'components/cockpit/rail/WhereCard.tsx',
];

/** Files still to be fixed by whoever owns them. Each line is a debt: remove it when the file is clean. */
const PENDING: Record<string, string> = {};

const RENDERED_PROPS = new Set(['label', 'hint', 'description', 'title', 'placeholder', 'text', 'blurb', 'group', 'sentence']);
const RENDERED_ATTRS = new Set(['aria-label', 'title', 'placeholder', 'label', 'description', 'alt']);

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

/** The text a person can read in one source text. */
export function renderedTexts(source: string, fileName = 'x.tsx'): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      if (node.text.trim()) out.push(node.text.trim());
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const parent = node.parent;
      if (ts.isPropertyAssignment(parent) && parent.initializer === node && (ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name)) && RENDERED_PROPS.has(parent.name.text)) {
        out.push(node.text);
      } else if (ts.isJsxAttribute(parent) && RENDERED_ATTRS.has(parent.name.getText(sf))) {
        out.push(node.text);
      } else if (ts.isJsxExpression(parent) && ts.isJsxElement(parent.parent)) {
        out.push(node.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function bannedIn(text: string, where: 'everywhere' | 'agent-screens' = 'agent-screens'): string[] {
  return BANNED_TERMS.filter((b) => (b.where === 'everywhere' || where === 'agent-screens') && b.pattern.test(text)).map((b) => `"${text.slice(0, 70)}" -> say "${b.use}"`);
}

describe('glossary: the checker', () => {
  it('finds banned words in JSX text, labels and aria-labels, and skips keywords and class names', () => {
    const src = `const r = { label: 'Accounts', keywords: 'login account', hint: 'Add another login' };
      export const C = () => <div className="login-box" aria-label="Open login pane" title="Fine">Chat (ACP) {'Puppet Master'}</div>;`;
    const hits = renderedTexts(src).flatMap((t) => bannedIn(t));
    expect(hits.length).toBe(5);
    expect(renderedTexts(src)).not.toContain('login account');
    expect(renderedTexts(src)).not.toContain('login-box');
  });
});

describe('glossary: the terms', () => {
  it('sign in is one phrase everywhere', () => {
    expect(SIGN_IN.action).toBe(TERMS.signIn);
    for (const text of [SIGN_IN.action, SIGN_IN.needed, SIGN_IN.group, SIGN_IN.rowLabel, SIGN_IN.rowHint, SIGN_IN.addAnother, SIGN_IN.openWindow, SIGN_IN.defaultOne]) {
      expect(bannedIn(text), text).toEqual([]);
      expect(text.toLowerCase()).toContain('sign');
    }
  });

  it('the ways to run an agent never show the protocol name', () => {
    for (const text of Object.values(RUN_WAYS)) expect(bannedIn(text), text).toEqual([]);
  });

  it('the welcome and Simple mode say agent, not helper or AI helper', () => {
    for (const text of [...firstRunStrings(), ...simpleStrings()]) {
      expect(bannedIn(text), text).toEqual([]);
      expect(text, text).not.toMatch(/\b(AI helpers?|helpers?)\b/i);
    }
  });
});

describe('glossary: no banned word in rendered text', () => {
  it('scans src/**/*.tsx', () => {
    const files = tsxFiles(SRC);
    expect(files.length).toBeGreaterThan(50);
    const hits: string[] = [];
    for (const file of files) {
      const rel = relative(SRC, file).replace(/\\/g, '/');
      if (rel in PENDING) continue;
      const where = AGENT_SCREENS.some((a) => rel.startsWith(a)) ? 'agent-screens' : 'everywhere';
      for (const text of renderedTexts(readFileSync(file, 'utf8'), file)) for (const hit of bannedIn(text, where)) hits.push(`${rel}: ${hit}`);
    }
    expect(hits).toEqual([]);
  });

  it('every pending file still has a banned word (so the list shrinks)', () => {
    for (const rel of Object.keys(PENDING)) {
      const texts = renderedTexts(readFileSync(join(SRC, rel), 'utf8'), rel);
      expect(texts.flatMap((t) => bannedIn(t)).length, rel).toBeGreaterThan(0);
    }
  });
});
