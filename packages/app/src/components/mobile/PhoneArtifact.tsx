// A page the agent made, full screen on the phone: the same locked frame as on the PC (no app access, no storage, no
// network but a short script-library list). The page comes from the PC over the bridge (`GET /panes/{id}/artifacts/{id}`),
// which first checks this phone's pairing, its `watch` right and the agent's own remote rule; a locked agent answers 403
// and the phone shows the sentence instead of a page. The phone is never told a file path.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../i18n';
import type { BridgeClient, PhoneArtifact } from '../../lib/bridge-types';
import { errorSentence } from '../../lib/sayError';
import { ArtifactBody } from '../artifacts/ArtifactBody';
import '../../styles/artifacts.css';

export function PhoneArtifactScreen({ bridge, paneId, id, version, title, onClose }: { bridge: BridgeClient | null; paneId: string; id: string; version: number; title: string; onClose: () => void }) {
  const t = useT();
  const [picked, setPicked] = useState(version);
  const [page, setPage] = useState<PhoneArtifact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const close = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    close.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (!bridge?.paneArtifact) {
      setError(t('artifacts.failed'));
      return;
    }
    let live = true;
    setPage(null);
    bridge.paneArtifact(paneId, id, picked).then(
      (p) => {
        if (!live) return;
        setPage(p);
        setError(null);
      },
      (err: unknown) => live && setError(errorSentence(err)),
    );
    return () => {
      live = false;
    };
  }, [bridge, paneId, id, picked, t]);

  const shown = page?.title ?? title;
  const body = error ? (
    <p className="ph-conv-sub" role="alert">
      {error}
    </p>
  ) : !page ? (
    <p className="ph-conv-sub">{t('artifacts.loading')}</p>
  ) : page.tooLarge || page.content === undefined ? (
    <p className="ph-conv-sub">{t('artifacts.phoneTooLarge')}</p>
  ) : (
    <ArtifactBody key={`${page.id}:${page.version}`} kind={page.kind} content={page.content} title={shown} className="ck-sandbox" fit />
  );
  return createPortal(
    <div className="ph-art" role="dialog" aria-modal="true" aria-label={t('artifacts.tabLabel', { title: shown })} data-testid="phone-artifact">
      <div className="ph-art-bar">
        <h2>{shown}</h2>
        {page && page.versions.length > 1 && (
          <select aria-label={t('artifacts.phoneVersions')} value={page.version} onChange={(e) => setPicked(Number(e.target.value))}>
            {[...page.versions].reverse().map((v) => (
              <option key={v.n} value={v.n}>
                {v.n === page.latest ? t('artifacts.versionLatest', { n: v.n }) : t('artifacts.versionOption', { n: v.n })}
              </option>
            ))}
          </select>
        )}
        <button ref={close} type="button" onClick={onClose}>
          {t('artifacts.phoneClose')}
        </button>
      </div>
      <div className="ph-art-body">{body}</div>
    </div>,
    document.querySelector('.ph') ?? document.body,
  );
}
