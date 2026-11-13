// "Another agent needs you", as a pill above the composer. Low-risk Yes or No is answered right on it (same answer path as the card,
// so the PC still checks the screen is the same prompt); anything else is one tap that jumps to that chat, with a back arrow in the
// header to come back. "+N" says how many more wait.
import { useT } from '../../i18n';
import type { AttentionItem } from '../../lib/attention';
import type { BridgeClient } from '../../lib/bridge-types';
import { useCardAnswer } from '../../hooks/useCardAnswer';
import { pillFor, type PillView } from '../../lib/phone-pill';
import type { AttentionSnapshot } from '../../lib/attention';
import '../../styles/phone-link.css';

function Quick({ item, quick, bridge, onRefresh }: { item: AttentionItem; quick: NonNullable<PillView['quick']>; bridge: Pick<BridgeClient, 'answerAttention'> | null; onRefresh?: () => void }) {
  const t = useT();
  const { local, send } = useCardAnswer(bridge, item, onRefresh);
  const busy = local.phase === 'sending';
  return (
    <>
      <button type="button" className="ph-pill-act" disabled={busy} onClick={() => send(quick.no)}>
        {t('phone.pill.no')}
      </button>
      <button type="button" className="ph-pill-act" data-primary disabled={busy} onClick={() => send(quick.yes)}>
        {t('phone.pill.yes')}
      </button>
    </>
  );
}

export function PhoneNeedsPill({
  snapshot,
  activePaneId,
  bridge,
  canAnswer,
  onJump,
  onRefresh,
}: {
  snapshot: AttentionSnapshot | null;
  activePaneId: string | null;
  bridge: Pick<BridgeClient, 'answerAttention'> | null;
  canAnswer: boolean;
  /** Open that agent's chat (the header then shows a back arrow). */
  onJump: (paneId: string) => void;
  onRefresh?: () => void;
}) {
  const t = useT();
  const pill = pillFor(snapshot, activePaneId);
  if (!pill) return null;
  const { item, more, quick } = pill;
  const who = item.pane?.heading ?? item.pane?.agent ?? t('phone.pill.someone');
  const what = item.risk?.headline?.trim() || item.title;
  return (
    <div className="ph-pill" data-testid="needs-pill">
      <button type="button" className="ph-pill-main" onClick={() => item.pane && onJump(item.pane.id)} aria-label={t('phone.pill.open', { name: who })}>
        <span>
          <b>{who}</b> · {what}
        </span>
        {more > 0 && <span className="ph-pill-more">{t('phone.pill.more', { n: more })}</span>}
      </button>
      {quick && canAnswer && <Quick key={item.id} item={item} quick={quick} bridge={bridge} onRefresh={onRefresh} />}
    </div>
  );
}
