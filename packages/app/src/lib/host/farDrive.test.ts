// "<PC> is driving / Take back" must never name the PC that is looking at the chat: the far PC names the driver by the id it gave
// THIS PC, so the far host drops a driver that is this PC and keeps any other (a phone, a third PC).
import { describe, expect, it } from 'vitest';
import { DevicesFake, MAC_MINI, NODE_MAC, farChatState } from '../../dev/devices-fixtures';
import { driveStrip } from '../acpChat';
import { makePcLinkClient } from '../runtime/pclink';
import { farHost, withoutSelfAsDriver } from './far';

const driven = (id: string) => farChatState('p1', { drive: { driver: { id, name: 'REN', typing: false, typing_ms: 0 }, took_back: null } });

function setup(id: string) {
  const f = new DevicesFake({ enabled: true, devices: [{ ...MAC_MINI, level: 'full' }], panes: {} });
  f.farLevels[NODE_MAC] = 'full';
  f.chatStates.p1 = driven(id);
  return farHost(makePcLinkClient(NODE_MAC, f), f, { name: 'Mac mini' });
}

describe('who drives a far chat', () => {
  it('this PC as the driver draws no strip', async () => {
    const state = await setup('link:this-pc').invoke<never>('acp_chat_state', { paneId: `dev:${NODE_MAC}:p1` });
    expect(driveStrip(state, Date.now(), Date.now())).toBeNull();
  });

  it('another device as the driver is named', async () => {
    const state = await setup('link:phone').invoke<never>('acp_chat_state', { paneId: `dev:${NODE_MAC}:p1` });
    expect(driveStrip(state, Date.now(), Date.now())?.name).toBe('REN');
  });

  it('an older far PC (no id for this PC) changes nothing', () => {
    const state = driven('link:this-pc');
    expect(withoutSelfAsDriver(state, undefined)).toBe(state);
  });
});
