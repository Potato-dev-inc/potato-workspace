// @vitest-environment jsdom
// Settings > Keys, rendered through the real section rows: a key found on this PC shows "Use the key found on this PC"
// and saving needs no typing (the value never reaches the page); with none found the button is absent; the spare
// OpenCode key waits for the main key; there is no "Check keys" button.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buttonByText, byLabel, click, hasText, mountRows, settle, type Mounted } from './test-utils';
import { keysRows } from './sections/KeysSection';

const mocks = vi.hoisted(() => ({
  secrets: {
    storageInfo: vi.fn<() => Promise<{ secure: boolean; label: string }>>(),
    getMasked: vi.fn<(name: string) => Promise<{ set: boolean; last4: string | null }>>(),
    set: vi.fn(async (_name: string, _value: string) => undefined),
    remove: vi.fn(async (_name: string) => undefined),
    foundOnPc: vi.fn<(name: string) => Promise<{ set: boolean; last4: string | null }>>(),
    useFound: vi.fn<(name: string) => Promise<{ set: boolean; last4: string | null }>>(),
  },
  stored: new Set<string>(),
  ocMainSet: false,
}));

vi.mock('../../lib/secrets', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/secrets')>()),
  secretsApi: mocks.secrets,
}));
vi.mock('../../lib/tauri', () => ({
  tauri: {
    getOpenCodeKeyStatus: vi.fn(async () => ({
      active_profile: 'a',
      profiles: [
        { id: 'a', label: 'Primary', configured: mocks.ocMainSet },
        { id: 'b', label: 'Secondary', configured: false },
      ],
      key_automation_mode: 'notify_only',
      restart_pane_on_rotate: true,
    })),
    setOpenCodeKeyProfile: vi.fn(async () => undefined),
    setOpenCodeAutomationSettings: vi.fn(),
  },
}));

let m: Mounted;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.stored.clear();
  mocks.ocMainSet = false;
  mocks.secrets.storageInfo.mockResolvedValue({ secure: true, label: 'Windows Credential Manager' });
  mocks.secrets.getMasked.mockImplementation(async (name) => (mocks.stored.has(name) ? { set: true, last4: 'ABCD' } : { set: false, last4: null }));
  mocks.secrets.foundOnPc.mockImplementation(async (name) =>
    name === 'openai_api_key' && !mocks.stored.has(name) ? { set: true, last4: 'ABCD' } : { set: false, last4: null },
  );
  mocks.secrets.useFound.mockImplementation(async (name) => {
    mocks.stored.add(name);
    return { set: true, last4: 'ABCD' };
  });
});
afterEach(async () => {
  await m?.unmount();
});

async function mount() {
  m = await mountRows(keysRows);
  await settle(6);
}

describe('Settings Keys screen', () => {
  it('offers the key found on this PC, saves it with one press and never shows the key', async () => {
    await mount();
    const buttons = [...m.host.querySelectorAll('button')].filter((b) => b.textContent === 'Use the key found on this PC');
    expect(buttons).toHaveLength(1); // only OpenAI has a key on this PC
    expect(hasText(m.host, 'A key ending in ABCD is already on this PC.')).toBe(true);
    await click(buttons[0]);
    await settle(6);
    expect(mocks.secrets.useFound).toHaveBeenCalledExactlyOnceWith('openai_api_key');
    expect(mocks.secrets.set).not.toHaveBeenCalled(); // no typing, and the page never held the value
    expect(m.env.markSaved).toHaveBeenCalled();
    expect(buttonByText(m.host, 'Use the key found on this PC')).toBeUndefined();
    expect(hasText(m.host, '•••• ABCD')).toBe(true);
  });

  it('shows no button when no key is found, and none when the keychain is missing', async () => {
    mocks.secrets.foundOnPc.mockResolvedValue({ set: false, last4: null });
    await mount();
    expect(buttonByText(m.host, 'Use the key found on this PC')).toBeUndefined();
    await m.unmount();
    mocks.secrets.foundOnPc.mockResolvedValue({ set: true, last4: 'ABCD' });
    mocks.secrets.storageInfo.mockResolvedValue({ secure: false, label: '' });
    await mount();
    expect(buttonByText(m.host, 'Use the key found on this PC')).toBeUndefined();
  });

  it('has no Check keys button; the spare key box waits for the main key', async () => {
    await mount();
    expect(buttonByText(m.host, 'Check keys')).toBeUndefined();
    expect(byLabel(m.host, 'OpenCode key A')).toBeTruthy();
    expect(byLabel(m.host, 'OpenCode key B')).toBeFalsy();
    expect(hasText(m.host, 'Add your main key first.')).toBe(true);
    await m.unmount();
    mocks.ocMainSet = true;
    await mount();
    expect(byLabel(m.host, 'OpenCode key B')).toBeTruthy();
  });
});
