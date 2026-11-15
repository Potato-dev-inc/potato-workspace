// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHAT_VIEW_DEFAULT_KEY, getChatViewDefault, parseChatViewMode, readChatViewMode, setChatViewDefault, writeChatViewMode } from './chatViewMode';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  setChatViewDefault('summary');
  localStorage.clear();
});

describe('parseChatViewMode', () => {
  it('keeps the three modes and makes anything else Normal', () => {
    expect(parseChatViewMode('summary')).toBe('summary');
    expect(parseChatViewMode('verbose')).toBe('verbose');
    expect(parseChatViewMode('loud')).toBe('normal');
    expect(parseChatViewMode(null)).toBe('normal');
  });
});

describe('the saved view mode of a pane', () => {
  it('is remembered per pane', () => {
    writeChatViewMode('pane-a', 'verbose');
    writeChatViewMode('pane-b', 'summary');
    expect(readChatViewMode('pane-a')).toBe('verbose');
    expect(readChatViewMode('pane-b')).toBe('summary');
    // A pane that never chose starts in Summary.
    expect(readChatViewMode('pane-c')).toBe('summary');
  });

  it('keeps a Normal chosen before Summary became the default', () => {
    localStorage.setItem('pm.chatView.old', 'normal');
    expect(readChatViewMode('old')).toBe('normal');
    expect(getChatViewDefault()).toBe('summary');
  });

  it('a new pane follows the global default; a pane with its own choice does not', () => {
    writeChatViewMode('mine', 'verbose');
    setChatViewDefault('normal');
    expect(localStorage.getItem(CHAT_VIEW_DEFAULT_KEY)).toBe('normal');
    expect(readChatViewMode('fresh')).toBe('normal');
    expect(readChatViewMode('mine')).toBe('verbose');
  });

  it('is the default and not saved without a pane', () => {
    writeChatViewMode(null, 'verbose');
    expect(readChatViewMode(null)).toBe('summary');
    expect(localStorage.length).toBe(0);
  });

  it('is the default when storage throws, and a write that fails does not throw', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readChatViewMode('pane-a')).toBe('summary');
    expect(() => writeChatViewMode('pane-a', 'summary')).not.toThrow();
  });
});
