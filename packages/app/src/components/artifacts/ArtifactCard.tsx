// The card a page the agent made leaves in the chat: its title, what kind it is, which version, and "Open". It is the
// notice line of kind `artifact`; a card whose address cannot be read falls back to the plain line.
import { memo } from 'react';
import { useT, type MessageKey } from '../../i18n';
import { parseArtifactRef, type ArtifactKind } from '../../lib/artifacts';
import { NoticeLine } from '../chat/NoticeLine';
import '../../styles/artifacts.css';

const KIND_KEY: Record<ArtifactKind, MessageKey> = {
  html: 'artifacts.kindHtml',
  markdown: 'artifacts.kindMarkdown',
  svg: 'artifacts.kindSvg',
  mermaid: 'artifacts.kindMermaid',
};

export const ArtifactCard = memo(function ArtifactCard({ title, url, onOpen }: { title: string; url?: string | null; onOpen: (ref: { id: string; version: number; kind: ArtifactKind }, title: string) => void }) {
  const t = useT();
  const ref = parseArtifactRef(url);
  if (!ref) return <NoticeLine text={title} kind="artifact" url={url} />;
  return (
    <div className="ck-artcard" data-testid="artifact-card" data-artifact-id={ref.id}>
      <span className="ck-artcard-mark" aria-hidden="true">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
          <rect x="2.5" y="2" width="11" height="12" rx="1.5" />
          <path d="M5 5.5h6M5 8h6M5 10.5h3.5" strokeLinecap="round" />
        </svg>
      </span>
      <span className="ck-artcard-text">
        <span className="ck-artcard-title">{title}</span>
        <span className="ck-artcard-meta">{t('artifacts.cardMeta', { kind: t(KIND_KEY[ref.kind]), n: ref.version })}</span>
      </span>
      <button type="button" className="ck-btn ck-btn--secondary ck-btn--sm" aria-label={t('artifacts.cardLabel', { title })} onClick={() => onOpen(ref, title)}>
        {t('artifacts.cardOpen')}
      </button>
    </div>
  );
});
