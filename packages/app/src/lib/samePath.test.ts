import { describe, expect, it } from 'vitest';
import { canonPaths, distinctPaths } from './samePath';

describe('one file, however it is spelled', () => {
  it('a relative path folds into the absolute one it ends', () => {
    expect(distinctPaths(['u1.txt', '/home/me/gp1/u1.txt'])).toEqual(['/home/me/gp1/u1.txt']);
    expect(distinctPaths(['/home/me/gp1/u1.txt', './u1.txt'])).toEqual(['/home/me/gp1/u1.txt']);
  });
  it('a Windows path and a slash path are the same file', () => {
    expect(distinctPaths(['src\\a.ts', 'D:\\p\\src\\a.ts'])).toEqual(['D:\\p\\src\\a.ts']);
    expect(distinctPaths(['/C:/p/a.ts', 'C:\\p\\a.ts'])).toHaveLength(1);
  });
  it('different files stay different', () => {
    expect(distinctPaths(['u1.txt', '/home/me/gp1/u2.txt'])).toHaveLength(2);
    expect(distinctPaths(['a/index.ts', '/x/b/index.ts'])).toHaveLength(2);
  });
  it('maps every spelling to its one path', () => {
    const m = canonPaths(['u1.txt', '/p/u1.txt']);
    expect(m.get('u1.txt')).toBe('/p/u1.txt');
  });
});

describe('the spellings agents really use', () => {
  it('a root-relative "file:///u1.txt" and "/u1.txt" are the project file', () => {
    expect(distinctPaths(['file:///u1.txt', '/home/me/gp1/u1.txt'])).toEqual(['/home/me/gp1/u1.txt']);
    expect(distinctPaths(['/u1.txt', '/home/me/gp1/u1.txt'])).toHaveLength(1);
  });
  it('two full paths in different folders stay two files', () => {
    expect(distinctPaths(['/a/x/u1.txt', '/b/x/u1.txt'])).toHaveLength(2);
  });
});
