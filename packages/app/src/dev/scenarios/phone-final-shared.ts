import { PANE_CODEX } from '../fixtures';
import type { HarnessScenario } from '../types';
import { setLanguagePref } from '../../i18n';
import { setPhoneTextSize } from '../../lib/phone-text-size';

// Shared by the phone-final evidence scenarios (the last pass of the phone redesign: header status, drawer, Settings text size,
// 320 px, zh-TW). No default export, so the registry skips this file.
export type FinalShot = 'chat' | 'drawer' | 'settings' | 'large';

export function phoneFinalScenario(shot: FinalShot, theme: 'dark' | 'light', opts: { zh?: boolean; narrow?: boolean } = {}): HarnessScenario {
  const suffix = [shot, theme, opts.narrow ? '320' : '', opts.zh ? 'zh' : ''].filter(Boolean).join('-');
  return {
    name: `phone-final-${suffix}`,
    route: 'phone',
    window: { width: opts.narrow ? 320 : 390, height: 844 },
    theme,
    phone: { activeTab: PANE_CODEX, chat: 'rich', digest: false, questions: false, attention: { blocking: 0 } },
    after: async (dom) => {
      if (opts.zh) setLanguagePref('zh-TW', false);
      await dom.waitFor('.ph-conv');
      await dom.sleep(600);
      if (shot === 'large') {
        setPhoneTextSize('large');
        await dom.sleep(400);
      }
      if (shot === 'drawer' || shot === 'settings') {
        await dom.click('.ph-head-menu');
        await dom.waitFor('.ph-drawer');
        await dom.sleep(400);
      }
      if (shot === 'settings') {
        await dom.click('.ph-dsettings');
        await dom.waitFor('[data-testid="phone-text-size"]');
        await dom.sleep(500);
      }
    },
  };
}
