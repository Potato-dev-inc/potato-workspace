import { SessionChatView } from '../components/chat/SessionChatView';
import { ChatComposer } from '../components/chat/ChatComposer';
import { groupTurns, type ChatItem } from '../lib/sessionChatModel';
import type { ChatAttachment } from '../lib/attachFiles';
import type { HarnessScenario } from './types';

// A chat whose first message has pictures attached; the scenario clicks the first thumbnail to open the large view.
const image = (name: string): ChatAttachment => ({ name, path: `/proj/${name}`, kind: 'image', size: 2048 });
const FILES = {
  wide: [image('wide-chart.png')],
  tall: [image('tall-page.png')],
  two: [image('two-a.png'), image('two-b.png')],
} as const;

export type ViewerKind = keyof typeof FILES;

export function ImageViewerPreview({ kind }: { kind: ViewerKind }) {
  const items: ChatItem[] = [
    { kind: 'user', id: 'u1', at: null, text: 'What do you make of these?', attachments: [...FILES[kind]] },
    { kind: 'assistant', id: 'a1', at: null, text: 'Here is what I see. The first one is the clearest.', model: null, finalAnswer: true },
    { kind: 'turnEnd', id: 'e1', at: null, outcome: 'completed', durationMs: 4000 },
  ];
  return (
    <div className="cockpit" style={{ position: 'fixed', inset: 0, zIndex: 999, background: 'var(--bg)', color: 'var(--label)' }}>
      <SessionChatView state="ready" reason={null} source="acp" turns={groupTurns(items).turns} model="Agent" cliVersion={null} paneId="preview-viewer" composer={<ChatComposer onSend={async () => null} blockedReason={null} />} />
    </div>
  );
}

import { createRoot } from 'react-dom/client';
import { createElement } from 'react';

export function viewerScenario(kind: ViewerKind, theme: 'light' | 'dark'): HarnessScenario {
  return {
    name: `image-viewer-${kind}-${theme}`,
    route: 'cockpit',
    theme,
    window: { width: 1000, height: 700 },
    after: async (dom) => {
      await dom.sleep(300);
      const host = document.createElement('div');
      (document.querySelector('.cockpit') ?? document.body).appendChild(host);
      createRoot(host).render(createElement(ImageViewerPreview, { kind }));
      await dom.sleep(800);
      await dom.click('button.ck-att-thumb');
      await dom.sleep(600);
    },
  };
}
