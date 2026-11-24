// The chat's header menu. "Save as page" and "Save as Markdown" show the chat in a preview and save that same text
// where the person picks. The sheet has a switch between Page and Markdown. Nothing is uploaded. The page preview is
// an iframe with an empty sandbox (no scripts) and the page as srcdoc, so the page cannot run code or reach anything.
// The Markdown preview is plain text.
// "Go live…" asks the cockpit to open the Go live sheet with this pane checked (the cockpit owns that sheet).
import { errorSentence } from '../../lib/sayError';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { chatExportFor, chatExportHtml, chatExportMarkdown, chatExportSave, chatPageFileName, type ExportFormat } from '../../lib/chatExport';
import { requestGoLive } from '../../lib/live-room';
import { IconMore } from '../cockpit/Icons';
import { SegTabs } from '../cockpit/SegTabs';
import { Sheet } from '../cockpit/Sheet';
import { FloatingMenu } from '../cockpit/FloatingMenu';
import { useT, type MessageKey } from '../../i18n';
import { useHost } from '../../lib/host/context';
import { localizeExportPreview } from '../../lib/chatExportPreview';

/** What the menu needs from the desktop shell (a fake in tests). */
export interface ChatExportApi {
  /** `title`: the chat's own name, which heads the page (a chat of another PC is headed by its own PC). */
  html: (paneId: string, title?: string) => Promise<{ html: string; token: string }>;
  markdown: (paneId: string, title?: string) => Promise<{ markdown: string; token: string }>;
  save: (token: string, path: string) => Promise<string>;
  /** The path the person picked, or null when they cancelled. */
  pickPath: (defaultName: string, format: ExportFormat) => Promise<string | null>;
}

const FILTERS: Record<ExportFormat, { name: string; extensions: string[] }> = {
  page: { name: 'Web page', extensions: ['html'] },
  markdown: { name: 'Markdown', extensions: ['md'] },
};

export const tauriChatExportApi: ChatExportApi = {
  html: chatExportHtml,
  markdown: chatExportMarkdown,
  save: chatExportSave,
  pickPath: async (defaultName, format) => {
    const picked = await saveDialog({ defaultPath: defaultName, filters: [FILTERS[format]] });
    return typeof picked === 'string' ? picked : null;
  },
};

const MENU_ITEMS: { format: ExportFormat; label: MessageKey }[] = [
  { format: 'page', label: 'r9.export.page' },
  { format: 'markdown', label: 'r9.export.markdown' },
];

/** A text Rust made: the preview and the save both use `text`, and only `token` saves it. */
interface Made {
  format: ExportFormat;
  text: string;
  token: string;
}

export function ChatExportMenu({ paneId, title, api: given, variant = 'icon', onMove }: { paneId: string; /** The chat's name ("Claude 8"): the page's title. */ title?: string; api?: ChatExportApi; /** "Move to…" in the menu (Devices): absent hides the entry. */ onMove?: () => void; /** `text`: a quiet "Share" button (the pane header), so it is not a second ⋯. */ variant?: 'icon' | 'text' }) {
  const t = useT();
  // A place that cannot build the file yet draws the same menu with every entry off and its one reason.
  const host = useHost();
  // The file is made where the chat lives and saved here, with this PC's Save dialog.
  const api = useMemo<ChatExportApi>(() => given ?? { ...tauriChatExportApi, ...chatExportFor(host) }, [given, host]);
  const off = host.can?.('chat_export_html') === false ? (host.notYet ?? null) : null;
  const [menuOpen, setMenuOpen] = useState(false);
  const [preview, setPreview] = useState<ExportFormat | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const closeMenu = (back: boolean) => {
    setMenuOpen(false);
    if (back) btn.current?.focus();
  };

  return (
    <>
      <div className="ck-menu-wrap">
        {variant === 'text' ? (
          <button ref={btn} type="button" className="ck-chat-share" aria-label={t('pane.shareLabel')} title={t('pane.shareTip')} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
            {t('pane.share')}
          </button>
        ) : (
          <button ref={btn} type="button" className="ck-icon-btn" aria-label={t('r9.export.menu')} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
            <IconMore />
          </button>
        )}
        {menuOpen && (
          <FloatingMenu anchorRef={btn} onClose={closeMenu} label={t('pane.shareLabel')}>
            {MENU_ITEMS.map((item) => (
              <button
                key={item.format}
                type="button"
                className="ck-menu-item"
                role="menuitem"
                disabled={off !== null}
                title={off ?? undefined}
                onClick={() => {
                  setMenuOpen(false);
                  setPreview(item.format);
                }}
              >
                {t(item.label)}
              </button>
            ))}
            <button
              type="button"
              className="ck-menu-item"
              role="menuitem"
              disabled={off !== null}
              title={off ?? undefined}
              onClick={() => {
                setMenuOpen(false);
                requestGoLive(paneId);
              }}
            >
              {t('r9.export.goLive')}
            </button>
            {onMove && (
              <button
                type="button"
                className="ck-menu-item"
                role="menuitem"
                data-testid="chat-menu-move"
                disabled={off !== null}
                title={off ?? undefined}
                onClick={() => {
                  setMenuOpen(false);
                  onMove();
                }}
              >
                {t('move.menu')}
              </button>
            )}
          </FloatingMenu>
        )}
      </div>
      {preview !== null && <SavePagePreview paneId={paneId} title={title} api={api} initial={preview} onClose={() => setPreview(null)} />}
    </>
  );
}

/** The chat as the file will hold it (a page, or Markdown), and the save. The preview and the saved file are the same text. */
export function SavePagePreview({
  paneId,
  title,
  api,
  initial = 'page',
  onClose,
}: {
  paneId: string;
  title?: string;
  api: ChatExportApi;
  initial?: ExportFormat;
  onClose: () => void;
}) {
  const titleId = useId();
  const t = useT();
  const [format, setFormat] = useState<ExportFormat>(initial);
  const [made, setMade] = useState<Made | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Bumped after each save: a token works once, so the text is made again for the next save.
  const [round, setRound] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    let alive = true;
    setLoadError(null);
    const asked: Promise<Made> =
      format === 'markdown'
        ? api.markdown(paneId, title).then((m) => ({ format, text: m.markdown, token: m.token }))
        : api.html(paneId, title).then((p) => ({ format, text: p.html, token: p.token }));
    asked
      .then((next) => {
        if (alive) setMade(next);
      })
      .catch((error: unknown) => {
        if (!alive) return;
        setMade(null);
        setLoadError(errorSentence(error));
      });
    return () => {
      alive = false;
    };
  }, [api, paneId, title, format, round]);

  // Only the text of the format on the switch is shown or saved.
  const current = made?.format === format ? made : null;
  const formatTabs = [{ id: 'page' as const, label: t('r9.export.tabPage') }, { id: 'markdown' as const, label: t('r9.export.tabMarkdown') }];

  const switchTo = (next: ExportFormat) => {
    if (next === format) return;
    setFormat(next);
    setMessage(null);
  };

  const save = async () => {
    if (current === null) return;
    setMessage(null);
    let path: string | null;
    try {
      path = await api.pickPath(chatPageFileName(new Date(), format), format);
    } catch (error) {
      setMessage({ text: t('r9.export.notSaved', { error: errorSentence(error) }), error: true });
      return;
    }
    if (!path) return;
    setBusy(true);
    try {
      const saved = await api.save(current.token, path);
      setMessage({ text: t('r9.export.saved', { path: saved }), error: false });
      setMade(null);
      setRound((n) => n + 1);
    } catch (error) {
      setMessage({ text: t('r9.export.notSaved', { error: errorSentence(error) }), error: true });
    } finally {
      setBusy(false);
    }
  };

  const body: ReactNode =
    current === null ? (
      <p className="ck-sub">{loadError ?? t(format === 'markdown' ? 'r9.export.makingFile' : 'r9.export.makingPage')}</p>
    ) : format === 'markdown' ? (
      <pre className="ck-chat-export-text">{localizeExportPreview(current.text, 'markdown')}</pre>
    ) : (
      <iframe className="ck-chat-export-frame" title={t('r9.export.previewTitle')} sandbox="" srcDoc={localizeExportPreview(current.text, 'page')} />
    );

  return (
    <Sheet labelledBy={titleId} role="dialog" onClose={busy ? undefined : onClose} className="ck-chat-export">
      <h2 id={titleId} className="ck-section">
        {t(format === 'markdown' ? 'r9.export.markdown' : 'r9.export.page')}
      </h2>
      <p className="ck-sub">
        {format === 'markdown'
          ? t('r9.export.noteMarkdown')
          : t('r9.export.notePage')}
      </p>
      <div className="ck-chat-export-switch">
        <SegTabs label={t('r9.export.formatLabel')} options={formatTabs} value={format} onChange={switchTo} />
      </div>
      <div className="ck-chat-export-body">{body}</div>
      {message && (
        <p role={message.error ? 'alert' : 'status'} className="ck-sub">
          {message.text}
        </p>
      )}
      <div className="ck-sheet-actions">
        <button type="button" className="ck-btn ck-btn--primary" disabled={current === null || busy} onClick={() => void save()}>
          {t(format === 'markdown' ? 'r9.export.markdownDots' : 'r9.export.pageDots')}
        </button>
        <button type="button" className="ck-btn ck-btn--secondary" disabled={busy} onClick={onClose}>
          {t('r9.export.close')}
        </button>
      </div>
    </Sheet>
  );
}
