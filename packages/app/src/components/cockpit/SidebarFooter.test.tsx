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
  it('every button carries a text label for wide windows', () => {
    mount();
    const labels = [...host.querySelectorAll('.ck-foot-icons .ck-icon-btn')].map((b) => b.querySelector('.ck-foot-label')?.textContent);
    expect(labels).toEqual(['Set up agents', 'Project', 'Review', 'More', 'Theme', 'Settings']);
  });

  it('Settings is a gear with its own shape, not the theme icon', () => {
    mount();
    const settings = host.querySelector('button[aria-label="Settings"] svg')!;
    const theme = host.querySelector('button[aria-label="Toggle theme"] svg')!;
    expect(settings.innerHTML).not.toBe(theme.innerHTML);
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
