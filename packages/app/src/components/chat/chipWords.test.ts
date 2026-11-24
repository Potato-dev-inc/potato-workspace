import { afterEach, describe, expect, it } from 'vitest';
import { useChinese, useEnglish } from '../../i18n/test-utils';
import { formatDuration } from './chatFormat';
import { chipWord, localizeChip } from './chipWords';
import { formatElapsed } from '../cockpit/model';
import { leftText } from '../../lib/lend';
import { activityText } from '../../lib/pane-activity';
import { farAgentName } from '../../lib/host/farCockpit';

afterEach(useEnglish);

describe('chipWord', () => {
  it('says the well-known setting words in zh-TW, by id or name, and leaves everything else alone', () => {
    useChinese();
    expect(chipWord('Manual')).toBe('手動');
    expect(chipWord('Fast mode')).toBe('快速模式');
    expect(chipWord('accept_edits')).toBe('接受編輯');
    expect(chipWord('Max')).toBe('最高');
    expect(chipWord('Fable 5.2')).toBe('Fable 5.2');
    expect(chipWord('Manual approvals for everything')).toBe('Manual approvals for everything');
  });
  it('is the identity in English', () => {
    useEnglish();
    expect(chipWord('Manual')).toBe('Manual');
  });
  it('keeps values and notes when it translates a chip', () => {
    useChinese();
    const chip = localizeChip({ id: 'fast', label: 'Fast mode', category: null, value: 'off', choices: [{ value: 'off', name: 'Off', description: 'Normal speed' }, { value: 'on', name: 'On', description: null }] });
    expect(chip.label).toBe('快速模式');
    expect(chip.choices.map((c) => c.name)).toEqual(['關', '開']);
    expect(chip.choices[0].value).toBe('off');
    expect(chip.choices[0].description).toBe('Normal speed');
  });
});

it('names an agent this PC does not list with a capital', () => {
  expect([farAgentName('agy'), farAgentName('')]).toEqual(['Agy', '']);
});

describe('time and state words', () => {
  it('writes units in zh-TW and keeps English as it was', () => {
    useEnglish();
    expect([formatDuration(500), formatDuration(48_000), formatDuration(125_000), formatElapsed(47 * 60_000), leftText(47 * 60_000)]).toEqual(['<1s', '48s', '2m 5s', '47m', '47m']);
    useChinese();
    expect([formatDuration(500), formatDuration(48_000), formatDuration(125_000), formatElapsed(47 * 60_000), leftText(47 * 60_000 - 1), leftText(134 * 60_000)]).toEqual(['少於 1 秒', '48 秒', '2 分鐘 5 秒', '47 分鐘', '47 分鐘', '2 小時 14 分鐘']);
  });
  it('translates only the two bare state words an agent line may carry', () => {
    useChinese();
    expect(activityText('running', { kind: 'working', text: 'Working' })).toBe('工作中');
    expect(activityText('idle', { kind: 'idle', text: 'Idle' })).toBe('閒置');
    expect(activityText('running', { kind: 'working', text: 'Running npm test' })).toBe('Running npm test');
  });
});
