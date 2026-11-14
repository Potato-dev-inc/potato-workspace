import { PANE_CODEX } from '../fixtures';
import type { HarnessScenario } from '../types';
import { setLanguagePref } from '../../i18n';

// Shared by the phone-r-chat evidence scenarios (redesign: folds, plan line, wrapped code). No default export, so the
// registry skips this file. `open` opens the folded Thought and the steps so the open look is shot too.
export function phoneRChatScenario(theme: 'dark' | 'light', opts: { zh?: boolean; open?: boolean } = {}): HarnessScenario {
  const suffix = opts.zh ? 'zh' : opts.open ? `${theme}-open` : theme;
  return {
    name: `phone-r-chat-${suffix}`,
    route: 'phone',
    window: { width: 390, height: 844 },
    theme,
    phone: { activeTab: PANE_CODEX, chat: 'rich', digest: false, questions: false, attention: { blocking: 0 } },
    after: async (dom) => {
      if (opts.zh) setLanguagePref('zh-TW', false);
      await dom.waitFor('.ph-conv');
      await dom.waitFor('[data-testid="plan-bar"]');
      await dom.sleep(600);
      if (opts.open) {
        for (const button of Array.from(document.querySelectorAll<HTMLElement>('[data-testid="thinking-block"] button, [data-testid="phone-fold"] button'))) button.click();
        await dom.sleep(400);
      }
    },
  };
}
