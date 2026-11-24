import { describe, expect, it } from 'vitest';
import { useEnglish } from '../../i18n/test-utils';
import { formatDelta } from './history-model';

useEnglish();
describe('the "Before undo" row', () => {
  it('says how many files were saved, not "No file changes"', () => {
    expect(formatDelta({ kind: 'undo', files: 1, added: 0, deleted: 1 })).toBe('1 file saved before undo');
    expect(formatDelta({ kind: 'undo', files: 3, added: 2, deleted: 0 })).toBe('3 files saved before undo');
  });
  it('other rows are unchanged', () => {
    expect(formatDelta({ kind: 'after', files: 2, added: 1, deleted: 1 })).toBe('2 files +1 −1');
  });
});
