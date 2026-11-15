// One version of a page, drawn. HTML, SVG and Mermaid go in the locked frame (`SandboxFrame`: no app access, no
// storage, no network but a short script-library list); Markdown is drawn by the app's own renderer.
//
// With `onPick` the page can be pointed at (Point and Fix): in the frame the picker is a script inside the page that
// talks by `postMessage` only; a note is the app's own text, so a click on it is read here.
import { useMemo, type MouseEvent } from 'react';
import { useT } from '../../i18n';
import { framePage, type ArtifactKind } from '../../lib/artifacts';
import { describeElement, type ArtifactPick } from '../../lib/artifact-point';
import { ChatMarkdown } from '../chat/ChatMarkdown';
import { SandboxFrame } from '../files/SandboxFrame';

export function ArtifactBody({
  kind,
  content,
  title,
  className,
  fit,
  picking = false,
  onPick,
}: {
  kind: ArtifactKind;
  content: string;
  title: string;
  className?: string;
  fit?: boolean;
  /** The next click is a pick. */
  picking?: boolean;
  onPick?: (pick: ArtifactPick) => void;
}) {
  const t = useT();
  const page = useMemo(() => (kind === 'markdown' ? null : framePage(kind, content)), [kind, content]);
  if (page === null) {
    const onClick = (event: MouseEvent<HTMLDivElement>) => {
      if (!picking || !onPick) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      // A link in a note must not leave the app while picking.
      event.preventDefault();
      event.stopPropagation();
      onPick(describeElement(target, event.currentTarget));
    };
    return (
      <div className={`ck-file-page${picking ? ' ck-art-picking' : ''}`} data-testid="artifact-markdown" onClickCapture={onClick}>
        <ChatMarkdown text={content} />
      </div>
    );
  }
  return (
    <SandboxFrame
      html={page.html}
      allowScripts={page.allowScripts}
      cdn={page.cdn}
      title={t('artifacts.frameLabel', { title })}
      className={className ?? 'ck-sandbox ck-sandbox--fill'}
      fit={fit}
      pickable={!!onPick}
      picking={picking}
      onPick={onPick}
    />
  );
}
