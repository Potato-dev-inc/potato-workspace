// What a long press on a message offers: Copy, Select text, Share, and on your own messages Edit and send again and Retry.
// Retry sends the same words as a new message; it never rewinds the chat. Share uses the phone's own share sheet when it has one.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useT } from '../../i18n';
import { useLongPress } from '../../hooks/useLongPress';
import { Sheet } from './MobileSheet';
import '../../styles/phone-pick.css';

/** What the person pressed. */
export interface PressedMessage {
  text: string;
  /** Your own message (Edit and Retry are offered). */
  mine: boolean;
}

/** Actions the conversation may offer on a message. Each is absent when this phone may not do it. */
export interface MessageActionHandlers {
  /** Sends `text` again as a new message. Resolves to null, or one plain sentence saying why not. */
  onRetry?: (text: string) => Promise<string | null>;
  /** Puts `text` in the message box to edit. */
  onEdit?: (text: string) => void;
}

/** A message that opens its actions on a long press (or the context key, which also works from a keyboard). Without onPress it is a plain block. */
export function Pressable({
  message,
  onPress,
  className,
  children,
}: {
  message: PressedMessage;
  onPress?: (message: PressedMessage) => void;
  className: string;
  children: ReactNode;
}) {
  const t = useT();
  const handlers = useLongPress(() => onPress?.(message));
  if (!onPress) return <div className={className}>{children}</div>;
  return (
    <div className={className} tabIndex={0} aria-description={t('phone.msg.open')} {...handlers}>
      {children}
    </div>
  );
}

export function MessageActionsSheet({ message, handlers, onClose }: { message: PressedMessage; handlers: MessageActionHandlers; onClose: () => void }) {
  const t = useT();
  const [mode, setMode] = useState<'menu' | 'select'>('menu');
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  useEffect(() => {
    if (mode !== 'select') return;
    const el = area.current;
    el?.focus();
    el?.select();
  }, [mode]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.text);
      setCopied(true);
      window.setTimeout(onClose, 700);
    } catch {
      // No clipboard (an insecure page): the text is shown to pick by hand instead.
      setMode('select');
    }
  };
  const share = () => {
    void navigator.share({ text: message.text }).then(onClose, () => undefined);
  };
  const retry = async () => {
    if (!handlers.onRetry) return;
    const refused = await handlers.onRetry(message.text);
    if (refused) setNote(refused);
    else onClose();
  };

  return (
    <Sheet title={t('phone.msg.title')} onClose={onClose}>
      {mode === 'menu' ? (
        <div className="ph-msgact" role="menu" data-testid="phone-msg-actions">
          <p className="ph-msgact-preview">{message.text}</p>
          <button type="button" role="menuitem" className="ph-msgact-btn" onClick={() => void copy()}>
            {copied ? t('phone.msg.copied') : t('phone.msg.copy')}
          </button>
          <button type="button" role="menuitem" className="ph-msgact-btn" onClick={() => setMode('select')}>
            {t('phone.msg.select')}
          </button>
          {canShare && (
            <button type="button" role="menuitem" className="ph-msgact-btn" onClick={share}>
              {t('phone.msg.share')}
            </button>
          )}
          {message.mine && handlers.onEdit && (
            <button
              type="button"
              role="menuitem"
              className="ph-msgact-btn"
              onClick={() => {
                handlers.onEdit?.(message.text);
                onClose();
              }}
            >
              {t('phone.msg.edit')}
            </button>
          )}
          {message.mine && handlers.onRetry && (
            <button type="button" role="menuitem" className="ph-msgact-btn" onClick={() => void retry()}>
              {t('phone.msg.retry')}
            </button>
          )}
          {note && (
            <p className="ph-msgact-note" role="alert">
              {note}
            </p>
          )}
        </div>
      ) : (
        <div className="ph-msgact" data-testid="phone-msg-select">
          <textarea ref={area} className="ph-msgact-select" readOnly value={message.text} aria-label={t('phone.msg.title')} />
          <p className="ph-msgact-note">{t('phone.msg.selectHint')}</p>
        </div>
      )}
    </Sheet>
  );
}
