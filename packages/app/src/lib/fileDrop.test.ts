// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerFileDrop as register, setFileDropSource, type DropSource, type WindowDropEvent } from './fileDrop';

function fakeSource() {
  let send: (e: WindowDropEvent) => void = () => {};
  const off = vi.fn();
  const source = vi.fn<DropSource>(async (cb) => {
    send = cb;
    return off;
  });
  return { source, off, emit: (e: WindowDropEvent) => send(e) };
}
const rect = (left: number, right: number) => () => ({ left, right, top: 0, bottom: 100 });
const flush = () => new Promise((r) => setTimeout(r, 0));

const offs: Array<() => void> = [];
const registerFileDrop: typeof register = (t) => {
  const off = register(t);
  offs.push(off);
  return off;
};
afterEach(() => {
  offs.splice(0).forEach((off) => off());
  setFileDropSource(null);
});

describe('one window drop listener for every place that takes files', () => {
  it('starts one listener for many targets and stops it with the last', async () => {
    const f = fakeSource();
    setFileDropSource(f.source);
    const a = registerFileDrop({ id: 'a', getRect: rect(0, 50), onDrop: vi.fn() });
    const b = registerFileDrop({ id: 'b', getRect: rect(50, 100), onDrop: vi.fn() });
    await flush();
    expect(f.source).toHaveBeenCalledTimes(1);
    a();
    expect(f.off).not.toHaveBeenCalled();
    b();
    expect(f.off).toHaveBeenCalledTimes(1);
  });

  it('hands a drop to the target under the pointer only', async () => {
    const f = fakeSource();
    setFileDropSource(f.source);
    const left = vi.fn();
    const right = vi.fn();
    registerFileDrop({ id: 'l', getRect: rect(0, 50), onDrop: left });
    registerFileDrop({ id: 'r', getRect: rect(50, 100), onDrop: right });
    await flush();
    f.emit({ type: 'drop', paths: ['C:\\a.txt'], position: { x: 70, y: 10 } });
    expect(right).toHaveBeenCalledWith(['C:\\a.txt']);
    expect(left).not.toHaveBeenCalled();
    f.emit({ type: 'drop', paths: ['C:\\a.txt'], position: { x: 500, y: 10 } });
    expect(right).toHaveBeenCalledTimes(1);
  });

  it('the higher priority wins where targets overlap', async () => {
    const f = fakeSource();
    setFileDropSource(f.source);
    const low = vi.fn();
    const high = vi.fn();
    registerFileDrop({ id: 'high', priority: 1, getRect: rect(0, 100), onDrop: high });
    registerFileDrop({ id: 'low', getRect: rect(0, 100), onDrop: low });
    await flush();
    f.emit({ type: 'drop', paths: ['x'], position: { x: 10, y: 10 } });
    expect(high).toHaveBeenCalled();
    expect(low).not.toHaveBeenCalled();
  });

  it('tells a target when files are over it and when they leave', async () => {
    const f = fakeSource();
    setFileDropSource(f.source);
    const over = vi.fn();
    registerFileDrop({ id: 'a', getRect: rect(0, 50), onDrop: vi.fn(), onOver: over });
    await flush();
    f.emit({ type: 'over', position: { x: 10, y: 10 } });
    f.emit({ type: 'over', position: { x: 12, y: 10 } });
    expect(over.mock.calls).toEqual([[true]]);
    f.emit({ type: 'leave' });
    expect(over.mock.calls).toEqual([[true], [false]]);
  });
});
