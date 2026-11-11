// The message box under the Chat tab: write a message for the agent. Enter sends, Shift+Enter makes a new line.
// The message is not typed at once: it waits until the agent is free (the pane outbox in the backend), and shows
// as a bubble under the conversation meanwhile (PendingMessages).
// `voice` adds the mic (phone only): speech turned into text on the device, see hooks/useVoiceInput.ts.
// `draftKey` (the pane) keeps the unsent text across pane switches and reloads, see lib/composerDraft.ts.
// `draft` is a message from the Point and Fix box ("Edit in Chat"): it goes into the box once, see useComposerDraft.
import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { MAX_MESSAGE_ATTACHMENTS, MAX_MESSAGE_CHARS } from '../../lib/paneOutbox';
import { clearDraft, DRAFT_SAVE_MS, readDraftState, writeDraft, type ComposerDraft } from '../../lib/composerDraft';
import { insertAtCursor } from '../../lib/voice';
import { pickFolder, pickImages, prepareAttachments, savePastedImage, type ChatAttachment } from '../../lib/attachFiles';
import { fileClipboard } from '../../lib/pasteFiles';
import { AttachMenu } from './AttachMenu';
import { AttachmentChips } from './AttachmentChips';
import { ContextMeter } from './ContextMeter';
import type { ContextReading } from '../cockpit/rail/railFormat';
import { ProjectFilePicker, findMentionQuery, removeMention, type ProjectFilePickerHandle } from './ProjectFilePicker';
import type { ProjectFileHit } from '../../lib/projectFiles';
import { useVoiceInput } from '../../hooks/useVoiceInput';
import { commandHint, commandText, filterCommands, type AcpCommand } from '../../lib/acpChat';
import '../../styles/cockpit-acp.css';
import '../../styles/chat-input-card.css';

/** The box grows with the text up to this many lines, then scrolls. */
const MAX_LINES = 6;
/** Show the character count from here on. */
const COUNT_FROM = 7000;

export const TOO_LONG_TEXT = `The message is too long. The most is ${MAX_MESSAGE_CHARS} characters.`;

export interface ChatComposerProps {
  /**
   * Sends the text, with the attached files (chips) when there are any. Resolves to null when it was accepted, else one
   * plain sentence saying why not.
   */
  onSend: (text: string, attachments?: ChatAttachment[]) => Promise<string | null>;
  /** Why the box is switched off (shown instead of a hint), or null. */
  blockedReason: string | null;
  /** Show the mic (voice typing on the device). Off for the desktop box. */
  voice?: boolean;
  /** The pane this box writes to: its unsent text is kept per pane. Without it, nothing is kept. */
  draftKey?: string;
  /** A Point and Fix message to put in the box. An empty box gets it; a typed text gets it after a blank line. */
  draft?: ComposerDraft | null;
  /** The slash commands the agent offers (a chat session over ACP). With some, typing "/" opens a menu above the box. */
  slashCommands?: readonly AcpCommand[];
  /** Controls drawn inside the box under the text (the agent's settings), left of the send button. */
  toolbar?: ReactNode;
  /** The agent is working: the button reads Stop (and Esc stops too) while this is true and `onStop` is set. */
  running?: boolean;
  /** Stops the agent (the pane's Interrupt). Without it the button stays Send. */
  onStop?: () => void;
  /** What the agent is doing, quietly in the footer left of the button. `stopping`: a Stop is on its way. */
  status?: { text: string; stopping: boolean } | null;
  /**
   * Desktop only: shows the add-files button and turns files dropped on the box into paths. Several files at once.
   * Without it the box has no paperclip (the phone cannot hand the agent a path on the PC).
   */
  attachFiles?: () => Promise<string[]>;
  /** How full the conversation window is (the ring in the footer). Without a reading the ring is not drawn. */
  contextUsage?: ContextReading | null;
}

function StopIcon() {
  return (
    <svg className="ck-chat-send-icon" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="5" y="5" width="14" height="14" rx="2" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </svg>
  );
}

/** One box per pane: switching panes remounts it, so each pane shows its own draft. */
export function ChatComposer(props: ChatComposerProps) {
  return <ChatComposerBox key={props.draftKey ?? ''} {...props} />;
}

function ChatComposerBox({ onSend, blockedReason, voice = false, draftKey, draft: pointDraft, slashCommands, toolbar, running = false, onStop, status, attachFiles, contextUsage }: ChatComposerProps) {
  const stoppable = running && !!onStop;
  const [restored] = useState(() => (draftKey ? readDraftState(draftKey) : { text: '', attachments: [] as ChatAttachment[] }));
  const [text, setText] = useState(restored.text);
  /** Files attached to the message, as chips inside the box. */
  const [attachments, setAttachments] = useState<ChatAttachment[]>(restored.attachments);
  /** Files being prepared (copied, or a pasted image being saved): each one shows a spinner chip. */
  const [preparing, setPreparing] = useState(0);
  /** Pasted images so far in this box, for the names `Pasted image 1.png`, `Pasted image 2.png`... */
  const pastedCount = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dropping, setDropping] = useState(false);
  /** Words heard but not final yet, and where in the text they would go. */
  const [interim, setInterim] = useState('');
  const [interimAt, setInterimAt] = useState(0);
  const field = useRef<HTMLTextAreaElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  /** Where the cursor goes after the next render (set after inserting recognized words). */
  const caretAfter = useRef<number | null>(null);
  const blocked = blockedReason !== null;
  // The slash menu: commands that start with what is typed after "/". Esc closes it until the text changes.
  const [menuAt, setMenuAt] = useState(0);
  const [menuShut, setMenuShut] = useState(false);
  const menuItems = slashCommands && !blocked && !menuShut ? filterCommands(slashCommands, text) : [];
  const menuOpen = menuItems.length > 0;
  // The `@` mention: typing "@word" at the caret opens the project file picker. Needs the same pane as the + button.
  const mentionsOn = !!attachFiles && !!draftKey && !blocked;
  const [mention, setMention] = useState<{ start: number; query: string; rect: DOMRect | null } | null>(null);
  /** Esc closes the picker until the text changes again. */
  const [mentionShut, setMentionShut] = useState(false);
  const pickerRef = useRef<ProjectFilePickerHandle>(null);
  const mentionOpen = mention !== null;
  const menuIx = Math.min(menuAt, Math.max(menuItems.length - 1, 0));
  const hint = slashCommands ? commandHint(slashCommands, text) : null;
  const count = [...text].length;
  const tooLong = count > MAX_MESSAGE_CHARS;
  const empty = text.trim() === '';
  const hasContent = !empty || attachments.length > 0;

  const mic = useVoiceInput({
    enabled: voice,
    onInterim: (heard) => {
      setInterim(heard);
      setInterimAt(field.current?.selectionStart ?? text.length);
    },
    onFinal: (chunk) => {
      const el = field.current;
      const value = el ? el.value : '';
      const start = el ? el.selectionStart : value.length;
      const end = el ? el.selectionEnd : value.length;
      const next = insertAtCursor(value, start, end, chunk);
      caretAfter.current = next.caret;
      setText(next.value);
      setInterim('');
    },
  });
  const micOff = blocked || busy || mic.support === 'checking';

  // The draft: written DRAFT_SAVE_MS after the last change, and at once when the box goes away or the page closes.
  // Only the text in the box is kept: words still being heard (interim) are not in `text` and never saved.
  const draft = useRef({ key: draftKey ?? '', text, attachments });
  const unsaved = useRef(false);
  const firstRun = useRef(true);
  useEffect(() => {
    if (!draftKey) return;
    draft.current = { key: draftKey, text, attachments };
    // The text loaded on mount is already saved: opening the box does not restart the 7 days.
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    unsaved.current = true;
    const timer = window.setTimeout(() => {
      unsaved.current = false;
      writeDraft(draftKey, text, Date.now(), attachments);
    }, DRAFT_SAVE_MS);
    return () => window.clearTimeout(timer);
  }, [text, attachments, draftKey]);
  useEffect(() => {
    const flush = () => {
      if (!unsaved.current) return;
      unsaved.current = false;
      writeDraft(draft.current.key, draft.current.text, Date.now(), draft.current.attachments);
    };
    const onHidden = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onHidden);
      flush();
    };
  }, []);

  // Grow with the text, up to MAX_LINES lines.
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    const line = parseFloat(getComputedStyle(el).lineHeight);
    const max = (Number.isFinite(line) ? line : 20) * MAX_LINES;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  }, [text]);

  // Put the cursor after recognized words, once the text has been rendered.
  useLayoutEffect(() => {
    const el = field.current;
    if (!el || caretAfter.current === null) return;
    el.setSelectionRange(caretAfter.current, caretAfter.current);
    caretAfter.current = null;
  }, [text]);

  // The Point and Fix draft: once per nonce (the same draft seen again does nothing). The cursor goes to the end.
  const appliedDraft = useRef<number | null>(null);
  useEffect(() => {
    if (!pointDraft || pointDraft.nonce === appliedDraft.current) return;
    appliedDraft.current = pointDraft.nonce;
    const next = text.trim() === '' ? pointDraft.text : `${text}\n\n${pointDraft.text}`;
    caretAfter.current = next.length;
    setText(next);
    setError(null);
    field.current?.focus();
  }, [pointDraft, text]);

  /** Looks for an `@word` at the caret and opens or closes the picker to match. */
  const syncMention = (value: string, caret: number) => {
    const found = mentionsOn && !mentionShut ? findMentionQuery(value, caret) : null;
    if (!found) {
      setMention(null);
      return;
    }
    setMention({ start: found.start, query: found.query, rect: field.current?.getBoundingClientRect() ?? null });
  };

  /** A file picked from the `@` list: the `@word` text goes, and the file becomes a chip (same as +). */
  const pickProjectFile = (file: ProjectFileHit) => {
    if (!mention) return;
    const el = field.current;
    const caret = el ? el.selectionStart : mention.start + mention.query.length + 1;
    const next = removeMention(text, mention.start, caret);
    setMention(null);
    caretAfter.current = mention.start;
    setText(next);
    setError(null);
    void addPaths([file.absPath]);
  };

  const closeMention = () => {
    setMention(null);
    setMentionShut(true);
  };

  /** Adds chips. A file already in the list (same path) is ignored; a message carries MAX_MESSAGE_ATTACHMENTS at most. */
  const addAttachments = (list: readonly ChatAttachment[]) => {
    if (list.length === 0) return;
    if (attachments.length + list.length > MAX_MESSAGE_ATTACHMENTS) setError(`A message can carry ${MAX_MESSAGE_ATTACHMENTS} files at most.`);
    setAttachments((current) => {
      const seen = new Set(current.map((a) => a.path));
      const fresh: ChatAttachment[] = [];
      for (const file of list) {
        if (seen.has(file.path)) continue;
        seen.add(file.path);
        fresh.push(file);
      }
      const room = Math.max(0, MAX_MESSAGE_ATTACHMENTS - current.length);
      return fresh.length === 0 ? current : [...current, ...fresh.slice(0, room)];
    });
  };

  const removeAttachment = (file: ChatAttachment) => {
    setAttachments((current) => current.filter((a) => a.path !== file.path));
    setError(null);
  };

  const submit = async () => {
    if (blocked || busy || preparing > 0 || tooLong || (empty && attachments.length === 0)) return;
    setMention(null);
    mic.halt();
    setBusy(true);
    setError(null);
    // The attachments travel only when there are some: a plain message is sent exactly as before.
    const refused = attachments.length > 0 ? await onSend(text.trim(), attachments) : await onSend(text.trim());
    setBusy(false);
    if (refused) setError(refused);
    else {
      setText('');
      setAttachments([]);
      if (draftKey) clearDraft(draftKey);
    }
    field.current?.focus();
  };

  /** Copies the picked paths for this pane and adds them as chips. A spinner chip shows while they are copied. */
  const addPaths = async (paths: readonly string[]) => {
    if (paths.length === 0) return;
    if (!draftKey) {
      setError('Could not read the chosen files.');
      return;
    }
    setPreparing((n) => n + 1);
    try {
      addAttachments(await prepareAttachments(draftKey, paths));
    } catch {
      setError('Could not read the chosen files.');
    } finally {
      setPreparing((n) => n - 1);
      field.current?.focus();
    }
  };

  const addFiles = async () => {
    if (!attachFiles || blocked || busy || preparing > 0) return;
    try {
      await addPaths(await attachFiles());
    } catch {
      setError('Could not open the file dialog.');
    }
  };

  const addPicked = async (pick: () => Promise<string[]>) => {
    if (!attachFiles || blocked || busy || preparing > 0) return;
    try {
      await addPaths(await pick());
    } catch {
      setError('Could not open the file dialog.');
    }
  };

  /** Saves one pasted image for this pane and adds it as a chip. */
  const savePasted = async (file: File) => {
    if (!draftKey) return;
    pastedCount.current += 1;
    const sub = file.type.split('/')[1] ?? '';
    const ext = sub === 'jpeg' ? 'jpg' : /^[a-z0-9]{1,8}$/i.test(sub) ? sub.toLowerCase() : 'png';
    setPreparing((n) => n + 1);
    try {
      addAttachments([await savePastedImage(draftKey, file, `Pasted image ${pastedCount.current}.${ext}`)]);
    } catch (error) {
      setError(error instanceof Error ? error.message : typeof error === 'string' ? error : 'Could not save the pasted image.');
    } finally {
      setPreparing((n) => n - 1);
    }
  };

  /** Attaches the files on the clipboard that the paste event did not give as paths (files copied in Explorer). */
  const addClipboardFiles = async () => {
    let paths: string[];
    try {
      paths = await fileClipboard().filePaths();
    } catch {
      setError('Could not read the files on the clipboard.');
      return;
    }
    await addPaths(paths);
  };

  // Pasting an image makes a chip (the image is saved for this pane). A file with a path on this PC makes a chip too.
  // A file the webview gives without a path, or a paste with no text and no files, asks the desktop app for the files
  // on the clipboard. Plain text pastes as it always did: the default is left alone.
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!draftKey || blocked || !attachFiles) return;
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length === 0 && (event.clipboardData?.getData('text/plain') ?? '') !== '') return;
    event.preventDefault();
    const images = files.filter((file) => file.type.startsWith('image/'));
    const others = files.filter((file) => !file.type.startsWith('image/'));
    const paths = others
      .map((file) => (file as File & { path?: string }).path)
      .filter((path): path is string => typeof path === 'string' && path !== '');
    if (paths.length > 0) void addPaths(paths);
    for (const image of images) void savePasted(image);
    if (others.length > paths.length || files.length === 0) void addClipboardFiles();
  };

  // Files dropped on the box become paths in the message. The desktop app reports the drop in window coordinates,
  // so each mounted box answers only for its own rectangle (split view has more than one).
  useEffect(() => {
    if (!attachFiles || typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
    let live = true;
    let stop: (() => void) | null = null;
    const inside = (x: number, y: number): boolean => {
      const rect = form.current?.getBoundingClientRect();
      if (!rect) return false;
      const scale = window.devicePixelRatio || 1;
      const px = x / scale;
      const py = y / scale;
      return px >= rect.left && px <= rect.right && py >= rect.top && py <= rect.bottom;
    };
    import('@tauri-apps/api/webview')
      .then(({ getCurrentWebview }) => {
        if (!live) return;
        getCurrentWebview()
          .onDragDropEvent((event) => {
            const payload = event.payload;
            if (payload.type === 'drop') {
              setDropping(false);
              if (inside(payload.position.x, payload.position.y)) addPaths(payload.paths);
              return;
            }
            if (payload.type === 'over') setDropping(inside(payload.position.x, payload.position.y));
            if (payload.type === 'leave') setDropping(false);
          })
          .then((unlisten) => {
            if (live) stop = unlisten;
            else unlisten();
          })
          .catch(() => undefined);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      stop?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- addPaths only touches setters and refs
  }, [attachFiles]);

  const pickCommand = (command: AcpCommand) => {
    const next = commandText(command);
    caretAfter.current = next.length;
    setText(next);
    setError(null);
    field.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // The `@` picker first: Enter picks, arrows move, Esc closes. While it is open Enter never sends.
    if (mentionOpen && !event.nativeEvent.isComposing) {
      if (pickerRef.current?.handleKey(event)) {
        if (event.key === 'Escape') closeMention();
        return;
      }
      // Enter with no file to pick (no matches, or still loading): close the picker and let Enter work as normal.
      if (event.key === 'Enter' && !event.shiftKey) closeMention();
    }
    if (menuOpen && !event.nativeEvent.isComposing) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setMenuAt((menuIx + step + menuItems.length) % menuItems.length);
        return;
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        event.preventDefault();
        pickCommand(menuItems[menuIx]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setMenuShut(true);
        return;
      }
    }
    // Esc while the agent works stops it (the same Interrupt as the pane menu).
    if (event.key === 'Escape' && stoppable && !event.nativeEvent.isComposing) {
      event.preventDefault();
      onStop?.();
      return;
    }
    // Enter while an input method is choosing a word is the method's, not ours.
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  };

  // The mic: a press starts (hold to talk, or tap to start and tap to stop). Focus stays in the box.
  const onMicDown = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (!micOff) mic.pressStart();
  };
  const onMicUp = () => mic.pressEnd();
  const onMicKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if ((event.key !== 'Enter' && event.key !== ' ') || event.repeat) return;
    event.preventDefault();
    if (!micOff) mic.tap();
  };

  const note = blockedReason ?? (tooLong ? TOO_LONG_TEXT : error);
  const showMirror = voice && interim !== '';
  const at = Math.min(interimAt, text.length);

  const textarea = (
    <textarea
      ref={field}
      rows={1}
      value={text}
      disabled={blocked}
      aria-label="Message to the agent"
      placeholder={blocked ? '' : (hint ?? 'Write a message for the agent')}
      {...(slashCommands && slashCommands.length > 0
        ? {
            role: 'combobox' as const,
            'aria-autocomplete': 'list' as const,
            'aria-expanded': menuOpen,
            'aria-controls': 'ck-slash-menu',
            'aria-activedescendant': menuOpen ? `ck-slash-opt-${menuIx}` : undefined,
          }
        : {})}
      onChange={(event) => {
        setText(event.target.value);
        setMenuAt(0);
        setMenuShut(false);
        setMentionShut(false);
        syncMention(event.target.value, event.target.selectionStart);
        if (error) setError(null);
      }}
      onSelect={(event) => {
        // The caret moved (arrows, click): the picker follows the `@word` under it.
        syncMention(event.currentTarget.value, event.currentTarget.selectionStart);
      }}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onScroll={(event) => {
        if (mirror.current) mirror.current.scrollTop = event.currentTarget.scrollTop;
      }}
      className={showMirror ? 'ck-chat-composer-field ck-chat-composer-field--voice' : 'ck-chat-composer-field'}
    />
  );

  return (
    <form
      ref={form}
      className={dropping ? 'ck-chat-composer ck-chat-composer--drop' : 'ck-chat-composer'}
      data-testid="chat-composer"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {mentionsOn && mention && (
        <ProjectFilePicker
          ref={pickerRef}
          paneId={draftKey!}
          query={mention.query}
          open={mentionOpen}
          anchorRect={mention.rect}
          onPick={pickProjectFile}
          onClose={closeMention}
        />
      )}
      {menuOpen && (
        <div className="ck-slash-anchor">
          <ul className="ck-slash-menu" id="ck-slash-menu" role="listbox" aria-label="Commands" data-testid="slash-menu">
            {menuItems.map((command, i) => (
              <li
                key={command.name}
                id={`ck-slash-opt-${i}`}
                role="option"
                aria-selected={i === menuIx}
                className="ck-slash-opt"
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setMenuAt(i)}
                onClick={() => pickCommand(command)}
              >
                <span className="ck-slash-name">/{command.name.replace(/^\/+/, '')}</span>
                <span className="ck-slash-desc">{command.description}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="ck-chat-composer-row">
        <AttachmentChips attachments={attachments} preparing={preparing} onRemove={removeAttachment} className="ck-chat-composer-chips" />
        {voice ? (
          <div className="ck-chat-composer-field-wrap">
            {showMirror && (
              <div ref={mirror} className="ck-chat-composer-mirror" aria-hidden="true" data-testid="chat-composer-mirror">
                {text.slice(0, at)}
                <span className="ck-chat-composer-interim">{interim}</span>
                {text.slice(at)}
                {' '}
              </div>
            )}
            {textarea}
          </div>
        ) : (
          textarea
        )}
        <div className="ck-chat-composer-foot">
          {attachFiles && (
            <AttachMenu
              disabled={blocked || busy || preparing > 0}
              onPickFiles={() => void addFiles()}
              onPickFolder={() => void addPicked(pickFolder)}
              onPickImage={() => void addPicked(pickImages)}
            />
          )}
          {toolbar && <div className="ck-chat-composer-toolbar">{toolbar}</div>}
          {voice && (
            <button
              type="button"
              className="ck-chat-mic"
              data-testid="chat-composer-mic"
              aria-label={mic.support === 'hint' ? "Voice typing: use your keyboard's mic" : 'Voice typing'}
              aria-pressed={mic.recording}
              aria-disabled={micOff || undefined}
              onPointerDown={onMicDown}
              onPointerUp={onMicUp}
              onPointerCancel={onMicUp}
              onPointerLeave={onMicUp}
              onKeyDown={onMicKey}
            >
              <MicIcon />
              {mic.recording && <span className="ck-chat-mic-dot" aria-hidden="true" data-testid="chat-composer-mic-dot" />}
            </button>
          )}
          {stoppable && status && (
            <span className="ck-chat-status" role="status" data-testid="chat-composer-status" data-stopping={status.stopping ? '' : undefined}>
              {status.text}
            </span>
          )}
          {contextUsage && <ContextMeter reading={contextUsage} />}
          {stoppable && !hasContent ? (
            // Nothing typed: the one round button is Stop, filled like the active Send.
            <button type="button" className="ck-btn ck-btn--primary ck-chat-send ck-chat-stop" data-testid="chat-composer-stop" aria-label="Stop" title="Stop (Esc)" disabled={status?.stopping} onClick={() => onStop?.()}>
              <StopIcon />
              <span className="ck-chat-send-label">Stop</span>
            </button>
          ) : (
            <>
              {stoppable && (
                // Text is typed while the agent works: Send queues it; Stop stays one small button away.
                <button type="button" className="ck-btn ck-chat-stop-mini" data-testid="chat-composer-stop" aria-label="Stop" title="Stop (Esc)" disabled={status?.stopping} onClick={() => onStop?.()}>
                  <StopIcon />
                </button>
              )}
              <button type="submit" className="ck-btn ck-btn--primary ck-chat-send" disabled={blocked || busy || preparing > 0 || !hasContent || tooLong}>
                <svg className="ck-chat-send-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 19V5" />
                  <path d="m5 12 7-7 7 7" />
                </svg>
                <span className="ck-chat-send-label">Send</span>
              </button>
            </>
          )}
        </div>
      </div>
      {voice && mic.note && (
        <p className="ck-chat-composer-note ck-chat-composer-voice" role="status" data-testid="chat-composer-voice">
          {mic.note}
        </p>
      )}
      {(note || count >= COUNT_FROM) && (
        <p className="ck-chat-composer-note" role={blocked ? undefined : 'alert'} data-testid="chat-composer-note">
          {note}
          {!blocked && count >= COUNT_FROM && (
            <span className="ck-chat-composer-count">
              {note ? ' · ' : ''}
              {count} / {MAX_MESSAGE_CHARS}
            </span>
          )}
        </p>
      )}
    </form>
  );
}
