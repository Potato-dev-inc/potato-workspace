// The phone's one message box: a large rounded box pinned to the bottom that grows as you type. Under the text: "+" (photos
// and files come later; the menu says so), the model pill (a read-only label for now), the microphone, and Send. Enter makes
// a new line (a phone keyboard has no Shift); Send sends. A message that cannot go yet waits in the outbox, as before.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { useT, type MessageKey } from '../../i18n';
import { ERROR_NOTES, LISTENING_NOTE, useVoiceInput } from '../../hooks/useVoiceInput';
import { clearDraft, DRAFT_SAVE_MS, readDraft, writeDraft } from '../../lib/composerDraft';
import { MAX_MESSAGE_CHARS } from '../../lib/paneOutbox';
import { insertAtCursor, KEYBOARD_MIC_HINT } from '../../lib/voice';
import type { ChatAttachment } from '../../lib/attachFiles';
import { MAX_SAVED_PROMPTS, readSavedPrompts, slashFilter, withPrompt, writeSavedPrompts, type QuickKind } from '../../lib/phone-quick';
import { AttachChips, PlusMenu, readClipboard, useAttachments, type UploadFn } from './PhoneAttach';
import { QuickReplies, SavedPrompts, starterPrompts } from './PhoneQuick';
import { PhoneVoiceBar } from './PhoneVoiceBar';
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
  pill,
  upload = null,
  quick = [],
  fill = null,
}: {
  /** Sends the text, with the files that were added when there are some. Resolves to null when it was accepted, else one plain sentence saying why not. */
  onSend: (text: string, attachments?: ChatAttachment[]) => Promise<string | null>;
  /** Sends one file to the PC for this chat (the "+" menu). Without it the menu items say the PC cannot take files yet. */
  upload?: UploadFn | null;
  /** Quick replies made from what the agent asked: chips above the box that fill it. */
  quick?: readonly QuickKind[];
  /** Puts this text in the box (a quick reply, "Ask to fix"). A new `nonce` fills again with the same text. */
  fill?: { text: string; nonce: number } | null;
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
  /** What sits where the model label does (the settings picker). `undefined`: the read-only model label; `null`: nothing. */
  pill?: ReactNode;
}) {
  const t = useT();
  const [text, setText] = useState(() => readDraft(draftKey));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [plus, setPlus] = useState(false);
  /** The mic's notes (the keyboard hint, listening, errors) show once the mic was used, not before. */
  const [micUsed, setMicUsed] = useState(false);
  const [interim, setInterim] = useState('');
  const attach = useAttachments(upload);
  const [saved, setSaved] = useState<string[] | null>(() => readSavedPrompts());
  const [slashClosed, setSlashClosed] = useState(false);
  /** The box as it was when this dictation began: the cross puts it back. */
  const voiceBase = useRef('');
  const field = useRef<HTMLTextAreaElement>(null);
  const caretAfter = useRef<number | null>(null);
  const blocked = blockedReason !== null;
  const count = [...text].length;
  const tooLong = count > MAX_MESSAGE_CHARS;
  const empty = text.trim() === '' && attach.ready.length === 0;
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
  const slash = slashClosed ? null : slashFilter(text);
  const prompts = saved ?? starterPrompts(t);
  const startedRecording = useRef(false);
  useEffect(() => {
    // Remember the box as it was when listening began.
    if (mic.recording && !startedRecording.current) voiceBase.current = field.current?.value ?? '';
    startedRecording.current = mic.recording;
  }, [mic.recording]);

  // A quick reply (or "Ask to fix") puts its text in the box and puts the cursor at its end. Nothing is sent.
  const filled = useRef(-1);
  useEffect(() => {
    if (!fill || fill.nonce === filled.current) return;
    filled.current = fill.nonce;
    caretAfter.current = fill.text.length;
    setText(fill.text);
    field.current?.focus();
  }, [fill]);
  const putText = (next: string) => {
    caretAfter.current = next.length;
    setText(next);
    setSlashClosed(false);
    field.current?.focus();
  };
  const changeSaved = (list: string[]) => {
    setSaved(list);
    writeSavedPrompts(list);
  };

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
    if (blocked || busy || tooLong || empty || attach.uploading) return;
    mic.halt();
    setBusy(true);
    setError(null);
    const refused = attach.ready.length > 0 ? await onSend(text.trim(), attach.ready) : await onSend(text.trim());
    setBusy(false);
    if (refused) {
      setError(refused);
    } else {
      setText('');
      attach.clear();
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

  const pasteFromClipboard = async () => {
    const refused = await readClipboard(attach.add, (pasted) => putText(text === '' ? pasted : `${text}${text.endsWith('\n') ? '' : '\n'}${pasted}`), t);
    if (refused) attach.setNote(refused);
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
  const note = blockedReason ?? (tooLong ? t('phone.composer.tooLong', { max: MAX_MESSAGE_CHARS }) : (error ?? attach.note));
  const voiceLine = mic.support === 'hint' ? t('phone.voice.unavailable') : null;
  return (
    <form
      className="ph-comp"
      data-testid="phone-composer"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {!blocked && slash === null && text.trim() === '' && <QuickReplies kinds={quick} onPick={putText} />}
      {!blocked && slash !== null && (
        <SavedPrompts
          prompts={prompts}
          filter={slash}
          onPick={putText}
          onAdd={(added) => changeSaved(withPrompt(prompts, added).slice(0, MAX_SAVED_PROMPTS))}
          onRemove={(gone) => changeSaved(prompts.filter((p) => p !== gone))}
          onClose={() => setSlashClosed(true)}
        />
      )}
      <div className="ph-comp-box">
        <AttachChips items={attach.items} onRemove={attach.remove} />
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
            if (slashClosed && slashFilter(event.target.value) === null) setSlashClosed(false);
            if (error) setError(null);
          }}
          onPaste={(event) => {
            const pasted = [...(event.clipboardData?.files ?? [])];
            if (pasted.length === 0 || !upload) return;
            event.preventDefault();
            attach.add(pasted);
          }}
          onKeyDown={onKeyDown}
        />
        {mic.recording ? (
          <PhoneVoiceBar
            words={interim}
            onKeep={() => mic.stop()}
            onDrop={() => {
              mic.halt();
              setText(voiceBase.current);
            }}
          />
        ) : (
          interim !== '' && <p className="ph-comp-interim" aria-live="polite">{interim}</p>
        )}
        <div className="ph-comp-row">
          <div className="ph-comp-plus">
            <button type="button" className="ph-comp-btn" aria-label={t('phone.composer.add')} aria-haspopup="menu" aria-expanded={plus} disabled={blocked} onClick={() => setPlus((v) => !v)}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
            {plus && <PlusMenu enabled={upload !== null} onFiles={attach.add} onPaste={() => void pasteFromClipboard()} onClose={() => setPlus(false)} />}
          </div>
          {pill === undefined ? (
            <span className="ph-comp-model" title={model ?? t('phone.composer.modelUnknown')}>
              {model ? t('phone.composer.model', { name: model }) : t('phone.composer.modelUnknown')}
            </span>
          ) : (
            (pill ?? <span className="ph-comp-model" aria-hidden="true" />)
          )}
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
            <button type="submit" className="ph-comp-send" disabled={blocked || busy || empty || tooLong || attach.uploading || mic.recording} aria-label={t('phone.composer.send')}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            </button>
          )}
        </div>
      </div>
      {micUsed && mic.note && !mic.recording && (
        <p className="ph-comp-note" role="status" data-testid="phone-mic-note">
          {voiceLine ?? micWords(mic.note)}
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
