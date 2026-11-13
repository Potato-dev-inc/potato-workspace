// @vitest-environment jsdom
// The sidebar footer: every icon button has a text label in the page (CSS shows it from 900px wide), and Settings
// is a gear that does not look like the theme button.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SidebarFooter } from './SidebarFooter';

vi.mock('./rail/JobsChip', () => ({ JobsChip: () => null }));
vi.mock('./night/NightChip', () => ({ NightChip: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const mount = () =>
  act(() =>
    root.render(
      <SidebarFooter
        names={new Map()}
        onOpenPane={() => {}}
        mode="orchestration"
        onMode={() => {}}
        theme="dark"
        onToggleTheme={() => {}}
        onOpenSettings={() => {}}
        onOpenDoctor={() => {}}
        onOpenMemory={() => {}}
        onOpenReview={() => {}}
        reviewCount={0}
      />,
    ),
  );

describe('SidebarFooter', () => {
  it('is one row: Settings, Review, and a More menu', () => {
    mount();
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('.ck-foot-icons > button, .ck-foot-icons .ck-menu-wrap > button')];
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['Settings', 'Review', 'More']);
    expect(host.querySelectorAll('.ck-foot-icons').length).toBe(1);
  });

  it('Theme, Project and Set up agents live in the More menu', () => {
    mount();
    expect(host.querySelector('button[aria-label="Toggle theme"]')).toBeNull();
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="More"]')!.click());
    const items = [...document.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent?.trim());
    expect(items).toEqual(expect.arrayContaining(['Project', 'Set up agents', 'Switch to light']));
  });

  it('shows no status line when there is nothing to say, and the lost connection when it is real', () => {
    mount();
    expect(host.querySelector('.ck-foot-status')!.children.length).toBe(0);
    act(() =>
      root.render(
        <SidebarFooter names={new Map()} onOpenPane={() => {}} mode="orchestration" onMode={() => {}} theme="dark" onToggleTheme={() => {}} onOpenSettings={() => {}} reviewCount={0} bridgeLine="x" />,
      ),
    );
    expect(host.querySelector('.ck-foot-status .ck-bridge')?.textContent).toContain('Connection lost');
  });

  it('in a narrow window (icons only) every footer button still has a name and a tooltip', () => {
    mount();
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('.ck-foot-icons button')];
    expect(buttons.length).toBe(3);
    for (const b of buttons) {
      expect(b.getAttribute('aria-label') ?? '').not.toBe('');
      expect(b.getAttribute('title') ?? '').not.toBe('');
    }
    for (const l of host.querySelectorAll('.ck-foot-label')) expect(l.getAttribute('aria-hidden')).toBe('true');
  });

  it('Settings is a gear with its own shape', () => {
    mount();
    const settings = host.querySelector('button[aria-label="Settings"] svg')!;
    expect(settings.querySelector('path')).not.toBeNull();
  });
});

describe('SidebarFooter: the Review count as text', () => {
  const mountWith = (reviewCount: number) =>
    act(() =>
      root.render(
        <SidebarFooter
          names={new Map()}
          onOpenPane={() => {}}
          mode="orchestration"
          onMode={() => {}}
          theme="dark"
          onToggleTheme={() => {}}
          onOpenSettings={() => {}}
          onOpenReview={() => {}}
          reviewCount={reviewCount}
        />,
      ),
    );

  it('names the count next to the Review icon when there is something to review', () => {
    mountWith(3);
    const btn = host.querySelector('button.ck-foot-review')!;
    expect(btn.querySelector('.ck-foot-label')?.textContent).toBe('Review · 3');
    expect(btn.getAttribute('aria-label')).toBe('Review, 3 waiting');
    expect(btn.querySelector('.ck-foot-badge')?.textContent).toBe('3');
  });

  it('shows just Review, and no badge, when there is nothing to review', () => {
    mountWith(0);
    const btn = host.querySelector('button.ck-foot-review')!;
    expect(btn.querySelector('.ck-foot-label')?.textContent).toBe('Review');
    expect(btn.querySelector('.ck-foot-badge')).toBeNull();
  });
});
