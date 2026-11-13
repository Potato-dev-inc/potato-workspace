// The phone's one message box: a large rounded box pinned to the bottom that grows as you type. Under the text: "+" (photos
// and files come later; the menu says so), the model pill (a read-only label for now), the microphone, and Send. Enter makes
// a new line (a phone keyboard has no Shift); Send sends. A message that cannot go yet waits in the outbox, as before.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useT, type MessageKey } from '../../i18n';
import { ERROR_NOTES, LISTENING_NOTE, useVoiceInput } from '../../hooks/useVoiceInput';
import { clearDraft, DRAFT_SAVE_MS, readDraft, writeDraft } from '../../lib/composerDraft';
import { MAX_MESSAGE_CHARS } from '../../lib/paneOutbox';
import { insertAtCursor, KEYBOARD_MIC_HINT } from '../../lib/voice';
import '../../styles/phone-shell.css';

/** The box grows with the text up to this many lines, then scrolls. */
const MAX_LINES = 6;

function MicIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </svg>
  );
}

export function PhoneComposer({
  onSend,
  blockedReason,
  draftKey,
  model,
  working = false,
  onStop,
}: {
  /** Sends the text. Resolves to null when it was accepted, else one plain sentence saying why not. */
  onSend: (text: string) => Promise<string | null>;
  /** Why the box is switched off, or null. */
  blockedReason: string | null;
  /** The chat this box writes to: its unsent text is kept per chat. */
  draftKey: string;
  /** The model the agent runs, shown as a read-only pill. */
  model: string | null;
  /** The agent is working now: with nothing typed, the Send button is a Stop button. */
  working?: boolean;
  /** Stops the agent's turn. Resolves to null, or one plain sentence saying why not. Without it there is no Stop button. */
  onStop?: () => Promise<string | null>;
}) {
  const t = useT();
  const [text, setText] = useState(() => readDraft(draftKey));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [plus, setPlus] = useState(false);
  /** The mic's notes (the keyboard hint, listening, errors) show once the mic was used, not before. */
  const [micUsed, setMicUsed] = useState(false);
  const [interim, setInterim] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);
  const caretAfter = useRef<number | null>(null);
  const blocked = blockedReason !== null;
  const count = [...text].length;
  const tooLong = count > MAX_MESSAGE_CHARS;
  const empty = text.trim() === '';
  const [stopping, setStopping] = useState(false);
  const stopMode = working && !!onStop && empty && blockedReason === null;

  const mic = useVoiceInput({
    enabled: true,
    onInterim: setInterim,
    onFinal: (chunk) => {
      const el = field.current;
      const value = el ? el.value : '';
      const next = insertAtCursor(value, el ? el.selectionStart : value.length, el ? el.selectionEnd : value.length, chunk);
      caretAfter.current = next.caret;
      setText(next.value);
      setInterim('');
    },
  });
  const micOff = blocked || busy || mic.support === 'checking';

  // The draft is kept per chat, a moment after the last change.
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    const timer = window.setTimeout(() => writeDraft(draftKey, text), DRAFT_SAVE_MS);
    return () => window.clearTimeout(timer);
  }, [text, draftKey]);

  // Grow with the text, up to MAX_LINES lines.
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    const line = parseFloat(getComputedStyle(el).lineHeight);
    el.style.height = `${Math.min(el.scrollHeight, (Number.isFinite(line) ? line : 22) * MAX_LINES)}px`;
  }, [text]);
  useLayoutEffect(() => {
    const el = field.current;
    if (!el || caretAfter.current === null) return;
    el.setSelectionRange(caretAfter.current, caretAfter.current);
    caretAfter.current = null;
  }, [text]);

  const submit = async () => {
    if (blocked || busy || tooLong || empty) return;
    mic.halt();
    setBusy(true);
    setError(null);
    const refused = await onSend(text.trim());
    setBusy(false);
    if (refused) {
      setError(refused);
    } else {
      setText('');
      clearDraft(draftKey);
    }
    field.current?.focus();
  };

  const stop = async () => {
    if (!onStop || stopping) return;
    setStopping(true);
    setError(null);
    const refused = await onStop();
    setStopping(false);
    if (refused) setError(refused);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // A keyboard with a modifier (a tablet with a keyboard) sends; a plain Enter is a new line.
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };
  const onMicDown = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setMicUsed(true);
    if (!micOff) mic.pressStart();
  };
  const onMicKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if ((event.key !== 'Enter' && event.key !== ' ') || event.repeat) return;
    event.preventDefault();
    setMicUsed(true);
    if (!micOff) mic.tap();
  };

  /** The mic notes come in English from the voice hook; the phone shows them in its own language. */
  const micWords = (line: string): string => {
    if (line === LISTENING_NOTE) return t('phone.composer.listening');
    if (line === KEYBOARD_MIC_HINT) return t('phone.composer.keyboardMic');
    const code = Object.keys(ERROR_NOTES).find((key) => ERROR_NOTES[key] === line);
    return code ? t(`phone.mic.${code}` as MessageKey) : line;
  };
  const note = blockedReason ?? (tooLong ? t('phone.composer.tooLong', { max: MAX_MESSAGE_CHARS }) : error);
  return (
    <form
      className="ph-comp"
      data-testid="phone-composer"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="ph-comp-box">
        <textarea
          ref={field}
          rows={1}
          value={text}
          disabled={blocked}
          aria-label={t('phone.composer.aria')}
          placeholder={blocked ? '' : t('phone.composer.placeholder')}
          enterKeyHint="enter"
          onChange={(event) => {
            setText(event.target.value);
            if (error) setError(null);
          }}
          onKeyDown={onKeyDown}
        />
        {interim !== '' && <p className="ph-comp-interim" aria-live="polite">{interim}</p>}
        <div className="ph-comp-row">
          <div className="ph-comp-plus">
            <button type="button" className="ph-comp-btn" aria-label={t('phone.composer.add')} aria-haspopup="menu" aria-expanded={plus} disabled={blocked} onClick={() => setPlus((v) => !v)}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
            {plus && (
              <div className="ph-comp-menu" role="menu" data-testid="phone-plus-menu">
                {(['camera', 'photos', 'files'] as const).map((item) => (
                  <button key={item} type="button" role="menuitem" aria-disabled="true" onClick={() => setPlus(false)}>
                    <span>{t(`phone.composer.${item}`)}</span>
                    <small>{t('phone.composer.soon')}</small>
                  </button>
                ))}
              </div>
            )}
          </div>
          <span className="ph-comp-model" title={model ?? t('phone.composer.modelUnknown')}>
            {model ? t('phone.composer.model', { name: model }) : t('phone.composer.modelUnknown')}
          </span>
          <button
            type="button"
            className="ph-comp-btn"
            data-testid="phone-mic"
            aria-label={mic.support === 'hint' ? t('phone.composer.micHint') : t('phone.composer.mic')}
            aria-pressed={mic.recording}
            aria-disabled={micOff || undefined}
            onPointerDown={onMicDown}
            onPointerUp={() => mic.pressEnd()}
            onPointerCancel={() => mic.pressEnd()}
            onKeyDown={onMicKey}
          >
            <MicIcon />
          </button>
          {stopMode ? (
            <button type="button" className="ph-comp-send ph-comp-stop" data-testid="phone-stop" disabled={stopping} aria-label={t('phone.composer.stop')} onClick={() => void stop()}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <rect x="7" y="7" width="10" height="10" rx="2" />
              </svg>
            </button>
          ) : (
            <button type="submit" className="ph-comp-send" disabled={blocked || busy || empty || tooLong} aria-label={t('phone.composer.send')}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            </button>
          )}
        </div>
      </div>
      {micUsed && mic.note && (
        <p className="ph-comp-note" role="status">
          {micWords(mic.note)}
        </p>
      )}
      {note && (
        <p className="ph-comp-note" role={blocked ? undefined : 'alert'} data-testid="phone-composer-note">
          {note}
        </p>
      )}
    </form>
  );
}
