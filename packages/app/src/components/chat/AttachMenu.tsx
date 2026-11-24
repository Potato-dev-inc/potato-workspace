// The "+" button of the message box: a small menu that asks what to add. It only reports the choice; the box picks
// and prepares the files (see lib/attachFiles). It opens upward, because the button sits at the bottom of the box.
import { useEffect, useRef, useState } from 'react';
import '../../styles/cockpit-chat-attachments.css';
import { Menu } from '../common/Floating';
import { t } from '../../i18n';

export interface AttachMenuProps {
  onPickFiles: () => void;
  onPickFolder: () => void;
  onPickImage: () => void;
  /** The box cannot take anything now (blocked, busy, or still preparing files): the button stays but does nothing. */
  disabled?: boolean;
  /** Why the button is off when this place cannot take files yet (its one plain line); shown as the button's title. */
  reason?: string | null;
}

function Svg({ children }: { children: React.ReactNode }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

const PlusIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </svg>
);
const FileIcon = () => (
  <Svg>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
  </Svg>
);
const FolderIcon = () => (
  <Svg>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </Svg>
);
const ImageIcon = () => (
  <Svg>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="m21 16-5-5-9 9" />
  </Svg>
);

export function AttachMenu({ onPickFiles, onPickFolder, onPickImage, disabled = false, reason = null }: AttachMenuProps) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const choose = (run: () => void) => () => {
    setOpen(false);
    trigger.current?.focus();
    run();
  };

  return (
    <div className="ck-menu-rel ck-attach-wrap" ref={wrap}>
      <button
        ref={trigger}
        type="button"
        className="ck-chat-attach"
        data-testid="chat-composer-attach"
        aria-label={t('attach.add')}
        title={reason ?? t('attach.hint')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-disabled={disabled || undefined}
        onClick={() => !disabled && setOpen((v) => !v)}
      >
        <PlusIcon />
      </button>
      {open && (
        <Menu anchorRef={trigger} align="start" prefer="up" className="ck-menu--compact ck-attach-menu" label={t('attach.add')} onClose={() => setOpen(false)}>
          <button type="button" role="menuitem" className="ck-menu-item" tabIndex={-1} onClick={choose(onPickFiles)}>
            <span className="ck-menu-ic">
              <FileIcon />
            </span>
            <span>{t('r9.attach.files')}</span>
          </button>
          <button type="button" role="menuitem" className="ck-menu-item" tabIndex={-1} onClick={choose(onPickFolder)}>
            <span className="ck-menu-ic">
              <FolderIcon />
            </span>
            <span>{t('r9.attach.folder')}</span>
          </button>
          <button type="button" role="menuitem" className="ck-menu-item" tabIndex={-1} onClick={choose(onPickImage)}>
            <span className="ck-menu-ic">
              <ImageIcon />
            </span>
            <span>{t('r9.attach.image')}</span>
          </button>
        </Menu>
      )}
    </div>
  );
}
