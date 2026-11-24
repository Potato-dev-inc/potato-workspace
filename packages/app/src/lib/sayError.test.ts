import { describe, expect, it } from 'vitest';
import { errorSentence, GENERIC_ERROR, sayError } from './sayError';

describe('sayError', () => {
  it('keeps a plain sentence from an Error or a string', () => {
    expect(sayError(new Error('The folder is full.')).text).toBe('The folder is full.');
    expect(sayError('Too many waiting messages.').text).toBe('Too many waiting messages.');
  });

  it('says plainly when the relay or the key store cannot be used, and keeps the raw text under details', () => {
    const down = sayError("Can't reach the relay: http://127.0.0.1:8798/v1/teams: Connection Failed (os error 10061)");
    expect(down.text).toBe('Could not reach the relay at 127.0.0.1:8798. Check the address and your internet, then try again.');
    expect(down.details).toContain('os error 10061');
    expect(sayError('Platform secure storage failure: Windows error code 8').text).toContain('no room left');
    expect(sayError('Platform secure storage failure: Windows error code 5').text).toContain('Windows would not open its store');
  });

  it('reads a backend { code, message } object', () => {
    const said = sayError({ code: 'NOPE', message: 'That name is taken.' }, 'saving');
    expect(said.text).toBe('That name is taken.');
    expect(said.details).toContain('Code: NOPE');
    expect(said.details).toContain('Where: saving');
  });

  it('strips a CODE: prefix and a type prefix', () => {
    expect(sayError('INVALID_ARGUMENT: Pick a folder first.').text).toBe('Pick a folder first.');
    expect(sayError(new Error('Error: Pick a folder first.')).text).toBe('Pick a folder first.');
  });

  it('maps a known code to its sentence', () => {
    expect(sayError('AGENT_NOT_INSTALLED: claude missing').text).toBe('That agent is not installed on this PC yet.');
    expect(sayError({ code: 'AGENT_EXITED' }).text).toContain('closed unexpectedly');
  });

  it('never shows programmer text, and keeps it under details', () => {
    const cases = [
      new TypeError("Cannot read properties of undefined (reading 'x')"),
      'undefined is not an object',
      'x is not a function',
      '[object Object]',
      'TypeError: boom',
      'Unexpected token < in JSON at position 0',
      'Error\n    at foo (file.js:1:2)',
      'Tauri command unavailable outside the desktop shell: x',
      'Failed to fetch',
    ];
    for (const c of cases) {
      const said = sayError(c);
      expect(said.text).toBe(GENERIC_ERROR);
      expect(said.details).not.toBe('');
    }
  });

  it('falls back for nothing at all, and honours a custom fallback', () => {
    for (const v of [undefined, null, {}, [], 42, '', '   ']) expect(sayError(v).text).toBe(GENERIC_ERROR);
    expect(errorSentence({}, 'Could not send the message.')).toBe('Could not send the message.');
  });

  it('never returns [object Object] for an object with no message', () => {
    expect(sayError({ a: 1 }).text).not.toContain('[object');
  });

  it('treats a very long message as unreadable', () => {
    expect(sayError('x'.repeat(500)).text).toBe(GENERIC_ERROR);
  });

  it('hides a command argument error behind the generic sentence', () => {
    const raw = 'invalid args `pane_id` for command `devices_chat_export`: command devices_chat_export missing required key pane_id';
    expect(sayError(raw).text).toBe(GENERIC_ERROR);
    expect(sayError('unknown pane: c9f7; pane_id must be a full pane id').text).toBe(GENERIC_ERROR);
  });
});
