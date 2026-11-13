// The "+" menu of the phone's message box and the chips of what is attached (P14). Camera, Photos, Files and Paste each
// add a file; the file goes to the PC at once (`POST /panes/{id}/uploads`) and shows as a chip in the box with a small
// picture. The message then carries the list, and the PC gives the agent the path like a file dropped on the desktop.
import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useT } from '../../i18n';
import { errorSentence } from '../../lib/sayError';
import type { ChatAttachment } from '../../lib/attachFiles';
import { checkUpload, FILE_ACCEPT, PHOTO_ACCEPT, sizeWords, UPLOAD_MAX_FILES } from '../../lib/phone-upload';
import '../../styles/phone-compose.css';

export type AttachState = 'uploading' | 'ready' | 'failed';

export interface AttachItem {
  key: string;
  name: string;
  size: number;
  state: AttachState;
  /** A small picture of the file (a local blob URL), for pictures only. */
  preview: string | null;
  attachment: ChatAttachment | null;
  /** One plain sentence when the file could not be sent. */
  error: string | null;
}

/** How a file gets to the PC. Resolves the attachment, or rejects with one plain sentence. */
export type UploadFn = (file: File) => Promise<ChatAttachment>;

type Translate = ReturnType<typeof useT>;
let nextKey = 1;

function refusalWords(t: Translate, reason: 'type' | 'big' | 'empty'): string {
  return reason === 'big' ? t('phone.attach.tooBig') : reason === 'type' ? t('phone.attach.badType') : t('phone.attach.empty');
}

/** The files in the box: add (checks, then uploads), remove, and the ones ready to go with the message. */
export function useAttachments(upload: UploadFn | null) {
  const t = useT();
  const [items, setItems] = useState<AttachItem[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const patch = useCallback((key: string, change: Partial<AttachItem>) => {
    if (live.current) setItems((current) => current.map((item) => (item.key === key ? { ...item, ...change } : item)));
  }, []);

  const add = useCallback(
    (files: readonly File[]) => {
      if (!upload) return;
      setNote(null);
      let room = UPLOAD_MAX_FILES - items.length;
      for (const file of files) {
        if (room <= 0) {
          setNote(t('phone.attach.tooMany', { max: UPLOAD_MAX_FILES }));
          break;
        }
        const check = checkUpload(file);
        if (!check.ok) {
          setNote(refusalWords(t, check.reason));
          continue;
        }
        room -= 1;
        const key = `a${nextKey++}`;
        const preview = file.type.startsWith('image/') && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : null;
        setItems((current) => [...current, { key, name: file.name || t('phone.attach.photo'), size: file.size, state: 'uploading', preview, attachment: null, error: null }]);
        upload(file).then(
          (attachment) => patch(key, { state: 'ready', attachment }),
          (error: unknown) => patch(key, { state: 'failed', error: errorSentence(error, t('phone.attach.failed')) }),
        );
      }
    },
    [upload, items.length, patch, t],
  );

  const remove = useCallback((key: string) => {
    setItems((current) => {
      const gone = current.find((item) => item.key === key);
      if (gone?.preview) URL.revokeObjectURL?.(gone.preview);
      return current.filter((item) => item.key !== key);
    });
  }, []);

  const clear = useCallback(() => {
    setItems((current) => {
      for (const item of current) if (item.preview) URL.revokeObjectURL?.(item.preview);
      return [];
    });
    setNote(null);
  }, []);

  const ready = items.filter((item) => item.state === 'ready' && item.attachment).map((item) => item.attachment as ChatAttachment);
  const uploading = items.some((item) => item.state === 'uploading');
  return { items, ready, uploading, note, setNote, add, remove, clear };
}

/** The chips: a small picture or a file mark, the name, the size, and a remove button. */
export function AttachChips({ items, onRemove }: { items: readonly AttachItem[]; onRemove: (key: string) => void }) {
  const t = useT();
  if (items.length === 0) return null;
  return (
    <ul className="ph-chips" data-testid="phone-attach-chips" aria-label={t('phone.attach.listAria')}>
      {items.map((item) => (
        <li key={item.key} className="ph-chip" data-state={item.state}>
          {item.preview ? <img src={item.preview} alt="" className="ph-chip-pic" /> : <span className="ph-chip-pic ph-chip-file" aria-hidden="true" />}
          <span className="ph-chip-text">
            <span className="ph-chip-name">{item.name}</span>
            <span className="ph-chip-sub">
              {item.state === 'uploading' ? t('phone.attach.sending') : item.state === 'failed' ? item.error : sizeWords(item.size)}
            </span>
          </span>
          <button type="button" className="ph-chip-x" aria-label={t('phone.attach.remove', { name: item.name })} onClick={() => onRemove(item.key)}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Reads the clipboard for pictures or files; text goes to `onText`. Resolves a plain sentence when nothing could be pasted. */
export async function readClipboard(onFiles: (files: File[]) => void, onText: (text: string) => void, t: Translate): Promise<string | null> {
  const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (!clip || typeof clip.read !== 'function') return t('phone.attach.pasteOff');
  try {
    const entries = await clip.read();
    const files: File[] = [];
    let text = '';
    for (const entry of entries) {
      const image = entry.types.find((type) => type.startsWith('image/'));
      if (image) {
        const blob = await entry.getType(image);
        files.push(new File([blob], `pasted.${image.split('/')[1] === 'jpeg' ? 'jpg' : (image.split('/')[1] ?? 'png')}`, { type: image }));
      } else if (entry.types.includes('text/plain')) {
        text += await (await entry.getType('text/plain')).text();
      }
    }
    if (files.length > 0) onFiles(files);
    else if (text.trim() !== '') onText(text);
    else return t('phone.attach.pasteEmpty');
    return null;
  } catch {
    return t('phone.attach.pasteOff');
  }
}

/** The four items of the "+" menu. The two pickers are hidden file inputs the items click. */
export function PlusMenu({
  enabled,
  onFiles,
  onPaste,
  onClose,
}: {
  /** The PC takes files (the route exists and the phone may type). Off: the items say so. */
  enabled: boolean;
  onFiles: (files: File[]) => void;
  onPaste: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const camera = useRef<HTMLInputElement>(null);
  const photos = useRef<HTMLInputElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    first.current?.focus();
  }, []);

  const picked = (event: ChangeEvent<HTMLInputElement>) => {
    const list = event.target.files ? [...event.target.files] : [];
    event.target.value = '';
    onClose();
    if (list.length > 0) onFiles(list);
  };
  const items: { id: 'camera' | 'photos' | 'files' | 'paste'; ref?: React.RefObject<HTMLInputElement | null> }[] = [
    { id: 'camera', ref: camera },
    { id: 'photos', ref: photos },
    { id: 'files', ref: files },
    { id: 'paste' },
  ];
  return (
    <div
      className="ph-comp-menu"
      role="menu"
      data-testid="phone-plus-menu"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      {items.map((item, index) => (
        <button
          key={item.id}
          ref={index === 0 ? first : undefined}
          type="button"
          role="menuitem"
          aria-disabled={!enabled || undefined}
          onClick={() => {
            if (!enabled) return;
            if (item.id === 'paste') {
              onClose();
              onPaste();
            } else item.ref?.current?.click();
          }}
        >
          <span>{t(`phone.attach.${item.id}`)}</span>
          {!enabled && <small>{t('phone.attach.off')}</small>}
        </button>
      ))}
      <input ref={camera} type="file" accept="image/*" capture="environment" hidden tabIndex={-1} data-testid="phone-pick-camera" onChange={picked} />
      <input ref={photos} type="file" accept={PHOTO_ACCEPT} multiple hidden tabIndex={-1} data-testid="phone-pick-photos" onChange={picked} />
      <input ref={files} type="file" accept={FILE_ACCEPT} multiple hidden tabIndex={-1} data-testid="phone-pick-files" onChange={picked} />
    </div>
  );
}
