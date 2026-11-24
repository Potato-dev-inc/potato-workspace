// @vitest-environment jsdom
// The far host rewrites every pane id of an event into this screen's key; the terminal registry holds the far PC's own id.
// Without the way back a far terminal got its screen once and then no output at all (blank pane, typing showed nothing).
import { describe, expect, it, vi } from 'vitest';
import { makePcLinkClient } from '../runtime/pclink';
import { farHost } from './far';
import { ALL_CAPS } from './host';
import { farPaneIo } from './farPanes';

const NODE = 'ab'.repeat(32);

function setup() {
  type Ev = { node: string; frame: string };
  const pushes: Array<(ev: Ev) => void> = [];
  const events = {
    subscribe: vi.fn(async () => undefined),
    unsubscribe: vi.fn(async () => undefined),
    onEvent: vi.fn(async (cb: (ev: Ev) => void) => (pushes.push(cb), () => {})),
  };
  const frame = (event: string, payload: unknown) => ({ node: NODE, frame: `event: app\ndata: ${JSON.stringify({ event, payload })}\n\n` });
  const client = makePcLinkClient(NODE, { ...events, request: vi.fn(async () => ({ status: 200, body: {} })) } as never);
  const io = farPaneIo(farHost(client, events as never, { name: 'Box', caps: ALL_CAPS }));
  return { io, emit: (event: string, payload: unknown) => pushes.forEach((push) => push(frame(event, payload))) };
}

describe('farPaneIo events', () => {
  it('hands output, size and lag to the registry under the far PC\'s own pane id', async () => {
    const { io, emit } = setup();
    const data = vi.fn();
    const sized = vi.fn();
    const lag = vi.fn();
    await io.onTerminalData(data);
    await io.onPtyResized(sized);
    await io.onTerminalLag!(lag);
    emit('terminal-data', { pane_id: 'p7', b64: btoa('hi'), offset: 3 });
    emit('pty://resized', { pane_id: 'p7', cols: 90, rows: 30 });
    emit('terminal-lag', { pane_id: 'p7' });
    expect(data).toHaveBeenCalledTimes(1);
    expect(data.mock.calls[0]![0].pane_id).toBe('p7');
    expect(new TextDecoder().decode(data.mock.calls[0]![0].data as Uint8Array)).toBe('hi');
    expect(sized.mock.calls[0]![0]).toMatchObject({ pane_id: 'p7', cols: 90, rows: 30 });
    expect(lag).toHaveBeenCalledWith('p7');
  });
});
