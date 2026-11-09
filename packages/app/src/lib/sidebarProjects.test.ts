// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  LS_SIDEBAR_PROJECTS,
  groupByProject,
  isInside,
  pathKey,
  projectLabel,
  readProjects,
  renamedProject,
  withProject,
  withoutProject,
} from './sidebarProjects';

type Item = { id: string; cwd?: string | null };
const cwdOf = (i: Item) => i.cwd;

describe('sidebar projects: paths', () => {
  it('compares Windows paths without case or slash style', () => {
    expect(pathKey('C:\\Work\\Shop\\')).toBe('c:/work/shop');
    expect(isInside('c:/work/shop/app', 'C:\\Work\\Shop')).toBe(true);
    expect(isInside('C:\\Work\\Shop', 'C:\\Work\\Shop')).toBe(true);
  });
  it('does not treat a sibling with the same start as inside', () => {
    expect(isInside('C:\\work\\shop-old', 'C:\\work\\shop')).toBe(false);
  });
  it('keeps the case of posix paths', () => {
    expect(isInside('/home/a/Shop', '/home/a/shop')).toBe(false);
    expect(isInside('/home/a/shop/x', '/home/a/shop')).toBe(true);
  });
});

describe('sidebar projects: the stored list', () => {
  beforeEach(() => localStorage.clear());
  it('adds a folder once, removes it and renames it', () => {
    let list = withProject([], 'C:\\work\\shop');
    list = withProject(list, 'c:/work/shop/');
    expect(list).toEqual([{ path: 'C:\\work\\shop' }]);
    list = renamedProject(list, 'C:\\work\\shop', '  Shop  ');
    expect(projectLabel(list[0])).toBe('Shop');
    list = renamedProject(list, 'C:\\work\\shop', '');
    expect(projectLabel(list[0])).toBe('shop');
    expect(withoutProject(list, 'C:\\WORK\\shop')).toEqual([]);
  });
  it('reads broken storage as no projects and drops bad entries', () => {
    localStorage.setItem(LS_SIDEBAR_PROJECTS, '{not json');
    expect(readProjects()).toEqual([]);
    localStorage.setItem(LS_SIDEBAR_PROJECTS, JSON.stringify([{ path: '/a' }, 3, { path: '' }, { path: '/a/' }, { path: '/b', name: 'B' }]));
    expect(readProjects()).toEqual([{ path: '/a' }, { path: '/b', name: 'B' }]);
  });
});

describe('sidebar projects: grouping', () => {
  const items: Item[] = [
    { id: '1', cwd: 'C:\\work\\shop' },
    { id: '2', cwd: 'C:\\work\\shop\\packages\\web' },
    { id: '3', cwd: 'C:\\work\\docs' },
    { id: '4', cwd: null },
    { id: '5', cwd: 'C:\\other\\blog' },
    { id: '6', cwd: 'C:\\work\\shop\\.potato-workspace\\worktrees\\abc' },
  ];
  const ids = (g: { items: Item[] }) => g.items.map((i) => i.id);

  it('puts an agent in the added project that holds its folder', () => {
    const groups = groupByProject(items, cwdOf, [{ path: 'C:\\work\\shop' }]);
    expect(groups[0]).toMatchObject({ name: 'shop', added: true });
    expect(ids(groups[0])).toEqual(['1', '2', '6']);
  });

  it('uses the longest matching folder', () => {
    const groups = groupByProject(items, cwdOf, [{ path: 'C:\\work\\shop' }, { path: 'C:\\work\\shop\\packages' }]);
    expect(ids(groups[0])).toEqual(['1', '6']);
    expect(ids(groups[1])).toEqual(['2']);
  });

  it('shows folders that were not added, then Other last', () => {
    const groups = groupByProject(items, cwdOf, [{ path: 'C:\\work\\shop' }]);
    expect(groups.map((g) => [g.name, g.added])).toEqual([
      ['shop', true],
      ['docs', false],
      ['blog', false],
      ['Other', false],
    ]);
    expect(groups[groups.length - 1]).toMatchObject({ path: null });
    expect(ids(groups[groups.length - 1])).toEqual(['4']);
  });

  it('keeps an added project with no agents, and the stored order', () => {
    const groups = groupByProject([], cwdOf, [{ path: 'D:\\b' }, { path: 'D:\\a', name: 'Alpha' }]);
    expect(groups.map((g) => [g.name, g.items.length])).toEqual([
      ['b', 0],
      ['Alpha', 0],
    ]);
  });

  it('groups a separate copy under its origin project when not added', () => {
    const groups = groupByProject([{ id: 'x', cwd: 'C:\\w\\app\\.potato-workspace\\worktrees\\one' }], cwdOf, []);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('app');
  });
});
