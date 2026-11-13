// Settings > General: "Save a diagnostic file". Shows what the zip would hold before anything is written;
// the person can leave any file out and read one before saving. Nothing is uploaded.
import { errorSentence } from '../../../lib/sayError';
import { t, useT } from '../../../i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { tauri, type DiagnosticPreview } from '../../../lib/tauri';
import { Btn, Note, SettingBlock, SettingRow } from '../settings-ui';
import { SpeedReadout } from './SpeedReadout';

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileName(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `potato-workspace-diagnostic-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.zip`;
}

/** While the list is open it re-reads itself this often, and whenever the window is focused again. */
export const DIAGNOSTIC_REFRESH_MS = 5000;

export function DiagnosticFile({ onSaved }: { onSaved?: () => void }) {
  const t = useT();
  const [preview, setPreview] = useState<DiagnosticPreview | null>(null);
  const [left, setLeft] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState<{ path: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const [crashed, setCrashed] = useState(false);
  useEffect(() => {
    let live = true;
    tauri
      .lastRunStatus()
      .then((run) => live && setCrashed(run?.closedUnexpectedly === true))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const busyRef = useRef(false);
  busyRef.current = busy;

  const review = async () => {
    setBusy(true);
    setMessage(null);
    try {
      setPreview(await tauri.diagnosticPreview());
      setLeft(new Set());
      setShown(null);
    } catch (e) {
      setMessage({ text: t('diag.lookFailed', { reason: errorSentence(e) }), error: true });
    } finally {
      setBusy(false);
    }
  };

  // A run can fail while the list is open: keep it current without a click. What the person ticked off
  // and the file they are reading stay as they are (a path that is gone drops out of both).
  const reread = useCallback(async () => {
    if (busyRef.current) return;
    try {
      const next = await tauri.diagnosticPreview();
      setPreview(next);
      const paths = new Set(next.files.map((file) => file.path));
      setLeft((current) => new Set([...current].filter((path) => paths.has(path))));
      setShown((current) => (current && paths.has(current.path) ? current : null));
    } catch {
      // The list on screen is still what was read last; a failed re-read is not worth an error.
    }
  }, []);

  const open = preview !== null;
  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => void reread(), DIAGNOSTIC_REFRESH_MS);
    const onFocus = () => void reread();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [open, reread]);

  const toggle = (path: string) =>
    setLeft((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const show = async (path: string) => {
    if (shown?.path === path) {
      setShown(null);
      return;
    }
    try {
      setShown({ path, text: await tauri.diagnosticShow(path) });
    } catch (e) {
      setMessage({ text: errorSentence(e), error: true });
    }
  };

  const save = async () => {
    setMessage(null);
    const target = await saveDialog({ defaultPath: fileName(), filters: [{ name: t('diag.zipFile'), extensions: ['zip'] }] });
    if (typeof target !== 'string') return;
    setBusy(true);
    try {
      const saved = await tauri.diagnosticSave(target, [...left]);
      setMessage({ text: t('diag.saved', { path: saved.path, size: size(saved.bytes) }), error: false });
      setPreview(null);
      setCrashed(false);
      onSaved?.();
    } catch (e) {
      setMessage({ text: t('settings.notSaved', { reason: errorSentence(e) }), error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {crashed && (
        <SettingRow
          label={t('diag.crashed')}
          description={t('diag.crashedHelp')}
        >
          <Btn disabled={busy} onClick={() => void save()}>
            {t('settings.row.diagnostic-file.label')}
          </Btn>
          <Btn small onClick={() => setCrashed(false)}>
            {t('diag.dismiss')}
          </Btn>
        </SettingRow>
      )}
      <SettingRow
        label={t('settings.row.diagnostic-file.label')}
        description={t('diag.help')}
      >
        <Btn disabled={busy} onClick={() => void review()}>
          {preview ? t('security.refresh') : t('diag.review')}
        </Btn>
      </SettingRow>
      {preview && (
        <SettingBlock
          label={t('diag.contains')}
          description={t('diag.containsHelp')}
        >
          <ul className="st-diag-list" aria-label={t('diag.filesAria')}>
            {preview.files.map((file) => (
              <li key={file.path} className="st-diag-item">
                <label className="st-diag-main">
                  <input type="checkbox" checked={!left.has(file.path)} onChange={() => toggle(file.path)} aria-label={file.label} />
                  <span className="st-diag-name">{file.label}</span>
                  <span className="st-diag-size">{size(file.bytes)}</span>
                </label>
                <Btn small onClick={() => void show(file.path)}>
                  {shown?.path === file.path ? t('diag.hide') : t('diag.show')}
                </Btn>
                {shown?.path === file.path && <pre className="st-diag-text">{shown.text}</pre>}
              </li>
            ))}
          </ul>
          <div className="st-diag-actions">
            <Btn primary disabled={busy || left.size >= preview.files.length} onClick={() => void save()}>
              {t('diag.saveDots')}
            </Btn>
            <Btn onClick={() => setPreview(null)}>{t('lend.cancel')}</Btn>
          </div>
        </SettingBlock>
      )}
      <SpeedReadout />
      {message && <Note role={message.error ? 'alert' : 'status'}>{message.text}</Note>}
    </>
  );
}
