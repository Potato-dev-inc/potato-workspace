// The files attached to a message, as chips: images as thumbnails, other files as small cards with a file icon, the
// extension and the size. The composer shows them inside its box (with an x to remove) and the transcript shows them
// read-only above the person's message. Clicking an image opens a larger preview; Escape closes it.
import { useEffect, useState } from 'react';
import { previewAttachment, type ChatAttachment } from '../../lib/attachFiles';
import '../../styles/cockpit-chat-attachments.css';

export interface AttachmentChipsProps {
  attachments: readonly ChatAttachment[];
  /** Files still being prepared: each shows a light spinner chip. */
  preparing?: number;
  /** Removes one chip (the x). Without it the chips are read-only. */
  onRemove?: (attachment: ChatAttachment) => void;
  /** Extra classes for the row (layout belongs to the parent). */
  className?: string;
}

/** A size in plain words: 512 B, 3.4 KB, 12 MB. */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** The extension in capitals (`notes.md` gives `MD`), or '' when the name has none. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toUpperCase();
}

function FileIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

/** What a folder chip says about its size: "12 files", "10,000+ files" (the count stops there), or just "Folder" when the count is not known. */
export function folderCountText(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return 'Folder';
  if (count >= 10_000) return '10,000+ files';
  return count === 1 ? '1 file' : `${count.toLocaleString('en-US')} files`;
}

function CloseIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </svg>
  );
}

/** The data URL of an image attachment, or null while it loads (or when there is none). */
function usePreview(attachment: ChatAttachment): string | null {
  const [src, setSrc] = useState<string | null>(null);
  const isImage = attachment.kind === 'image';
  useEffect(() => {
    setSrc(null);
    if (!isImage) return;
    let live = true;
    void previewAttachment(attachment.path).then((url) => {
      if (live) setSrc(url);
    });
    return () => {
      live = false;
    };
  }, [attachment.path, isImage]);
  return src;
}

/** One chip. Images show a thumbnail; the x appears on hover and on keyboard focus. */
function Chip({ attachment, onRemove, onOpen }: { attachment: ChatAttachment; onRemove?: (a: ChatAttachment) => void; onOpen: (a: ChatAttachment) => void }) {
  const src = usePreview(attachment);
  const remove = onRemove ? (
    <button type="button" className="ck-att-remove" aria-label={`Remove ${attachment.name}`} title="Remove" onClick={() => onRemove(attachment)}>
      <CloseIcon />
    </button>
  ) : null;

  if (attachment.kind === 'image') {
    return (
      <div className="ck-att-chip ck-att-chip--image" data-testid="attachment-chip" data-kind="image" data-name={attachment.name}>
        <button type="button" className="ck-att-thumb" aria-label={`Open ${attachment.name}`} title={attachment.name} onClick={() => onOpen(attachment)}>
          {src ? <img src={src} alt="" className="ck-att-thumb-img" draggable={false} /> : <span className="ck-att-thumb-placeholder" aria-hidden="true" />}
        </button>
        {remove}
      </div>
    );
  }

  const folder = attachment.kind === 'folder';
  const meta = folder ? folderCountText(attachment.size) : [extensionOf(attachment.name), formatSize(attachment.size)].filter(Boolean).join(' · ');
  return (
    <div className="ck-att-chip ck-att-chip--file" data-testid="attachment-chip" data-kind={attachment.kind} data-name={attachment.name}>
      <span className="ck-att-file-icon" aria-hidden="true">
        {folder ? <FolderIcon /> : <FileIcon />}
      </span>
      <span className="ck-att-file-text">
        <span className="ck-att-name" title={folder ? attachment.path : attachment.name}>
          {attachment.name}
        </span>
        {meta && <span className="ck-att-meta">{meta}</span>}
      </span>
      {remove}
    </div>
  );
}

/** The larger view of an image chip. Escape and the backdrop close it. */
function ImagePreview({ attachment, onClose }: { attachment: ChatAttachment; onClose: () => void }) {
  const src = usePreview(attachment);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="ck-att-overlay" role="dialog" aria-modal="true" aria-label={attachment.name} data-testid="attachment-preview" onClick={onClose}>
      <div className="ck-att-overlay-body" onClick={(event) => event.stopPropagation()}>
        {src ? <img src={src} alt={attachment.name} className="ck-att-overlay-img" /> : <span className="ck-att-overlay-loading">Loading preview</span>}
        <div className="ck-att-overlay-foot">
          <span className="ck-att-overlay-name">{attachment.name}</span>
          <button type="button" className="ck-att-overlay-close" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

export function AttachmentChips({ attachments, preparing = 0, onRemove, className }: AttachmentChipsProps) {
  const [open, setOpen] = useState<ChatAttachment | null>(null);
  if (attachments.length === 0 && preparing <= 0) return null;
  const rowClass = className ? `ck-att-row ${className}` : 'ck-att-row';
  return (
    <>
      <div className={rowClass} data-testid="attachment-chips">
        {attachments.map((attachment) => (
          <Chip key={attachment.path} attachment={attachment} onRemove={onRemove} onOpen={setOpen} />
        ))}
        {preparing > 0 && (
          <div className="ck-att-chip ck-att-chip--loading" role="status" aria-label="Preparing files" data-testid="attachment-preparing">
            <span className="ck-att-spinner" aria-hidden="true" />
            <span className="ck-att-meta">Preparing</span>
          </div>
        )}
      </div>
      {open && <ImagePreview attachment={open} onClose={() => setOpen(null)} />}
    </>
  );
}
