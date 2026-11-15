import { describe, expect, it } from 'vitest';
import { friendlyPhoneName, modelFromUserAgent, nameForModel, readPhoneName } from './phoneName';

const OPPO_UA = 'Mozilla/5.0 (Linux; Android 15; CPH2689 Build/AP3A.240617.008) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const PIXEL_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const GENERIC_UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

describe('a friendly phone name', () => {
  it('reads the model out of an Android user agent and puts the brand in front of it', () => {
    expect(modelFromUserAgent(OPPO_UA)).toBe('CPH2689');
    expect(friendlyPhoneName(OPPO_UA)).toBe('OPPO CPH2689');
  });

  it('prefers the Client Hints model over the (reduced) user agent', () => {
    expect(friendlyPhoneName(GENERIC_UA, { model: 'CPH2689' })).toBe('OPPO CPH2689');
    expect(friendlyPhoneName(GENERIC_UA)).toBe('Android phone');
  });

  it('puts the brand in front of a model code that means nothing alone, and leaves a clear name alone', () => {
    expect(nameForModel('SM-A546B')).toBe('Samsung SM-A546B');
    expect(nameForModel('CPH2000')).toBe('OPPO CPH2000');
    expect(friendlyPhoneName(PIXEL_UA)).toBe('Google Pixel 9');
    expect(nameForModel('Samsung Galaxy A55')).toBe('Samsung Galaxy A55');
  });

  it('names an iPhone, an iPad and a computer', () => {
    expect(friendlyPhoneName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe('iPhone');
    expect(friendlyPhoneName('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)')).toBe('iPad');
    expect(friendlyPhoneName('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('Windows PC');
    expect(friendlyPhoneName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('Mac');
    expect(friendlyPhoneName('weird')).toBe('Mobile device');
  });

  it('asks the browser for Client Hints, and falls back when it refuses or has none', async () => {
    const withHints = { userAgent: GENERIC_UA, userAgentData: { getHighEntropyValues: async () => ({ model: 'CPH2689', platform: 'Android' }) } };
    expect(await readPhoneName(withHints)).toBe('OPPO CPH2689');
    const refuses = { userAgent: PIXEL_UA, userAgentData: { getHighEntropyValues: async () => Promise.reject(new Error('no')) } };
    expect(await readPhoneName(refuses)).toBe('Google Pixel 9');
    expect(await readPhoneName({ userAgent: OPPO_UA })).toBe('OPPO CPH2689');
  });
});
