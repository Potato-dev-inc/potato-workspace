// @vitest-environment jsdom
// The phone rows Connect > Phone draws: every control renders, saves the right partial patch, and revoking all devices is confirmed.
import { unsearchableLabels } from '../test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blur, buttonByText, byLabel, click, hasText, mountRows, settle, type as typeInto, type Mounted } from '../test-utils';
import { phoneRowsOriginal as phoneRows } from './PhoneSection';

const mocks = vi.hoisted(() => ({
  devices: [] as Array<{ id: string; name: string; public_key: string; paired_at: number }>,
  activity: [] as unknown[],
}));

vi.mock('../../../lib/tauri', () => ({
  tauri: {
    listPairedMobileDevices: vi.fn(async () => mocks.devices),
    revokePairedMobileDevice: vi.fn(async () => true),
    phoneActivityList: vi.fn(async () => mocks.activity),
    phoneActivityClear: vi.fn(async () => {
      mocks.activity = [];
      return true;
    }),
  },
}));
vi.mock('../TunnelSection', async () => {
  const { createElement } = await import('react');
  return { TunnelSection: () => createElement('p', null, 'Tunnel stub') };
});
vi.mock('../blocks/TelegramSetup', async () => {
  const { createElement } = await import('react');
  return { TelegramSetup: () => createElement('p', null, 'Telegram stub') };
});
vi.mock('../../MobilePairingPanel', async () => {
  const { createElement: h } = await import('react');
  return {
    DEVICES_CHANGED_EVENT: 'pm-devices-changed',
    MobilePairingPanel: (props: { onPublicPwaUrlChange: (v: string) => void; onDevServerPortChange: (p: number) => void }) =>
      h(
        'div',
        null,
        h('p', null, 'Pairing stub'),
        h('button', { type: 'button', onClick: () => props.onPublicPwaUrlChange('https://x.example') }, 'Stub set URL'),
        h('button', { type: 'button', onClick: () => props.onPublicPwaUrlChange('') }, 'Stub clear URL'),
        h('button', { type: 'button', onClick: () => props.onDevServerPortChange(4000) }, 'Stub set port'),
      ),
  };
});

import { tauri } from '../../../lib/tauri';

let m: Mounted;

async function mount(overrides: Parameters<typeof mountRows>[1] = {}) {
  m = await mountRows(phoneRows, overrides);
  await settle(5);
  return m;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.devices = [
    { id: '11111111-aaaa-4aaa-8aaa-111111111111', name: 'Pixel 8', public_key: 'k1', paired_at: 1 },
    { id: '22222222-bbbb-4bbb-8bbb-222222222222', name: 'iPhone', public_key: 'k2', paired_at: 2 },
  ];
});
afterEach(async () => {
  await m?.unmount();
});

const switchFor = (label: string) => m.host.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${label}"]`);

describe('Phone: every control renders', () => {
  it('shows every phone row that is not on the Connect page itself', async () => {
    await mount();
    for (const id of ['phone-notifications', 'mobile-keyboard-resizes', 'mobile-input-visible', 'revoke-all-devices', 'telegram']) {
      expect(m.host.querySelector(`[data-row="${id}"]`), `missing row: ${id}`).not.toBeNull();
    }
    expect(hasText(m.host, 'Telegram')).toBe(true);
    expect(hasText(m.host, 'Telegram stub')).toBe(true);
    expect(hasText(m.host, 'Tag Your Agent')).toBe(false);
    expect(hasText(m.host, 'Phone alerts')).toBe(true);
    expect(hasText(m.host, 'On the phone')).toBe(true);
    expect(switchFor('Keyboard resizes the agent')).toBeTruthy();
    expect(switchFor('Show the typing box on the phone')).toBeTruthy();
    expect(hasText(m.host, 'Revoke all devices')).toBe(true);
    expect(buttonByText(m.host, 'Revoke…')).toBeTruthy();
    expect(m.host.querySelectorAll('[data-row]')).toHaveLength(5);
  });

  it('Telegram is its own list with the setup block in it', async () => {
    await mount();
    const row = m.host.querySelector('[data-row="telegram"]');
    expect(row?.textContent).toContain('Telegram stub');
    const list = row?.closest('section.st-group');
    expect(list?.textContent).toContain('Telegram');
    expect(list?.getAttribute('data-danger')).not.toBe('true');
  });

  it('has no Save button, no planned controls and no pairing approval switch', async () => {
    await mount();
    expect(buttonByText(m.host, 'Save changes')).toBeUndefined();
    expect(hasText(m.host, 'Planned')).toBe(false);
    expect(hasText(m.host, 'Require pairing approval')).toBe(false);
  });

  it('puts the destructive row in its own last list', async () => {
    await mount();
    const lists = [...m.host.querySelectorAll('section.st-group')];
    const last = lists[lists.length - 1];
    expect(last.getAttribute('data-danger')).toBe('true');
    expect(last.querySelectorAll('[data-row]')).toHaveLength(1);
    expect(last.textContent).toContain('Revoke all devices');
    expect(lists.slice(0, -1).some((s) => s.textContent?.includes('Revoke all devices'))).toBe(false);
  });
});

describe('Phone: each control saves a partial patch', () => {
  it('Keyboard resizes the agent saves only {mobile_keyboard_resizes_agent}', async () => {
    await mount();
    await click(switchFor('Keyboard resizes the agent'));
    expect(m.env.patches).toEqual([{ mobile_keyboard_resizes_agent: true }]);
  });

  it('Show the typing box on the phone saves only {mobile_input_visible}', async () => {
    await mount();
    await click(switchFor('Show the typing box on the phone'));
    expect(m.env.patches).toEqual([{ mobile_input_visible: false }]);
  });

});

describe('Phone: revoke all devices', () => {
  it('is disabled when no phone is paired', async () => {
    mocks.devices = [];
    await mount();
    expect(buttonByText(m.host, 'Revoke…')!.disabled).toBe(true);
  });

  it('declining the confirm revokes nothing', async () => {
    await mount();
    m.env.confirm.mockResolvedValueOnce(false);
    await click(buttonByText(m.host, 'Revoke…'));
    await settle();
    expect(m.env.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Revoke all devices?', confirmLabel: 'Revoke all' }));
    expect(tauri.revokePairedMobileDevice).not.toHaveBeenCalled();
    expect(m.env.markSaved).not.toHaveBeenCalled();
  });

  it('confirming revokes every paired device and ticks the row', async () => {
    await mount();
    await click(buttonByText(m.host, 'Revoke…'));
    await settle(5);
    expect(tauri.revokePairedMobileDevice).toHaveBeenCalledTimes(2);
    expect(tauri.revokePairedMobileDevice).toHaveBeenNthCalledWith(1, '11111111-aaaa-4aaa-8aaa-111111111111');
    expect(tauri.revokePairedMobileDevice).toHaveBeenNthCalledWith(2, '22222222-bbbb-4bbb-8bbb-222222222222');
    expect(m.env.markSaved).toHaveBeenCalledTimes(1);
    expect(m.env.patches).toEqual([]);
  });
});

describe('Phone: search covers what the section shows', () => {
  it('every word of every label a row shows finds that row', async () => {
    await mount();
    expect(unsearchableLabels(m.host, phoneRows, ['pixel', 'iphone'])).toEqual([]);
  });
});
