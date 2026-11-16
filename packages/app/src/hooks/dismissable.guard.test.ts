// @vitest-environment node
// App-wide guard: a dropdown or popover in components/ does not hand-roll its own "press outside" listener. It uses
// hooks/useDismissable, so every one closes the same way (outside press, Escape, focus leaving, window blur, page scroll).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const components = path.join(here, '../components');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.tsx?$/.test(name) && !/\.test\./.test(name) ? [full] : [];
  });
}

describe('every dropdown closes through useDismissable', () => {
  it('no component adds its own mousedown or pointerdown listener to close a menu', () => {
    // dnd/dragStore clears a drag; it is not a menu.
    const own = sources(components).filter((file) => !file.endsWith('dragStore.ts') &&  /addEventListener\(\s*['"](mousedown|pointerdown)['"]/.test(readFileSync(file, 'utf8')));
    expect(own.map((f) => path.relative(components, f))).toEqual([]);
  });

  it('the pickers named in the plan use the shared rule', () => {
    // A menu that moved onto the shared Menu (common/Floating) closes through useDismissable inside it.
    const uses = (rel: string) => {
      const text = readFileSync(path.join(components, rel), 'utf8');
      return text.includes('useDismissable') || text.includes('common/Floating');
    };
    for (const rel of [
      'cockpit/newagent/NewAgentPage.tsx', // the New agent project picker
      'common/Floating.tsx', // the shared Popover and Menu (the New agent menu and other floating menus)
      'chat/ChipMenu.tsx', // the chat chips (agent, mode, model)
      'chat/AttachMenu.tsx',
      'cockpit/UsageBar.tsx',
      'cockpit/ProjectHeader.tsx',
      'cockpit/Sidebar.tsx',
    ]) {
      expect(uses(rel), rel).toBe(true);
    }
  });
});
