// The row at the top of a long chat: "Show earlier messages". Used by the desktop chat and the phone chat.
import { useT } from '../../i18n';
import type { EarlierState } from '../../hooks/useEarlier';
import '../../styles/chat-picture.css';

export function EarlierRow({ earlier, onPress }: { earlier: EarlierState; onPress?: () => void }) {
  const t = useT();
  if (!earlier.more) return null;
  return (
    <div className="ck-earlier" data-testid="show-earlier">
      <button
        type="button"
        className="ck-earlier-btn"
        disabled={earlier.busy}
        onClick={() => {
          onPress?.();
          earlier.show();
        }}
      >
        {earlier.busy ? t('chat.earlier.loading') : t('chat.earlier.show')}
      </button>
      {earlier.failed && !earlier.busy && (
        <p className="ck-earlier-failed" role="alert">
          {t('chat.earlier.failed')}
        </p>
      )}
    </div>
  );
}
