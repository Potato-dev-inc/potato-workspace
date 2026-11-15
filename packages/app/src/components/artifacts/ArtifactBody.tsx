// One version of a page, drawn. HTML, SVG and Mermaid go in the locked frame (`SandboxFrame`: no app access, no
// storage, no network but a short script-library list); Markdown is drawn by the app's own renderer.
import { useMemo } from 'react';
import { useT } from '../../i18n';
import { framePage, type ArtifactKind } from '../../lib/artifacts';
import { ChatMarkdown } from '../chat/ChatMarkdown';
import { SandboxFrame } from '../files/SandboxFrame';

export function ArtifactBody({ kind, content, title, className, fit }: { kind: ArtifactKind; content: string; title: string; className?: string; fit?: boolean }) {
  const t = useT();
  const page = useMemo(() => (kind === 'markdown' ? null : framePage(kind, content)), [kind, content]);
  if (page === null) {
    return (
      <div className="ck-file-page" data-testid="artifact-markdown">
        <ChatMarkdown text={content} />
      </div>
    );
  }
  return <SandboxFrame html={page.html} allowScripts={page.allowScripts} cdn={page.cdn} title={t('artifacts.frameLabel', { title })} className={className ?? 'ck-sandbox ck-sandbox--fill'} fit={fit} />;
}
