// One version of a page, drawn. HTML, SVG and Mermaid go in the locked frame (`SandboxFrame`: no app access, no
// storage, no network but a short script-library list); Markdown is drawn by the app's own renderer.
//
// With `onPick` the page can be pointed at (Point and Fix): in the frame the picker is a script inside the page that
// talks by `postMessage` only; a note is the app's own text, so a click on it is read here. With `markup` the mark-up
// bar's Select tool does the same and also reports the box under the mouse (so the app draws the outline itself).
import { useEffect, useMemo, useRef, type MouseEvent } from 'react';
import { useT } from '../../i18n';
import { framePage, type ArtifactKind } from '../../lib/artifacts';
import { describeElement, type ArtifactPick } from '../../lib/artifact-point';
import { ChatMarkdown } from '../chat/ChatMarkdown';
import { SandboxFrame, type FrameMarkup } from '../files/SandboxFrame';

export type BodyMarkup = FrameMarkup;

function boxIn(el: Element, stage: HTMLElement | null) {
  const b = el.getBoundingClientRect();
  const s = stage?.getBoundingClientRect();
  return { x: b.left - (s?.left ?? 0), y: b.top - (s?.top ?? 0), w: b.width, h: b.height };
}

const oneWord = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 24);

/** A Markdown page: the app's own text, so the bar reads the element under the mouse straight from the page. */
function MarkdownBody({ content, picking, onPick, markup }: { content: string; picking: boolean; onPick?: (pick: ArtifactPick) => void; markup?: BodyMarkup }) {
  const wrap = useRef<HTMLDivElement>(null);
  const registerProbe = markup?.registerProbe;
  const stageRef = markup?.stage;
  useEffect(() => {
    if (!registerProbe) return;
    registerProbe(async (x, y) => {
      const s = stageRef?.current?.getBoundingClientRect();
      const el = document.elementFromPoint((s?.left ?? 0) + x, (s?.top ?? 0) + y);
      return el && wrap.current && wrap.current.contains(el) && el !== wrap.current ? describeElement(el, wrap.current) : null;
    });
    return () => registerProbe(null);
  }, [registerProbe, stageRef]);
  const under = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    return target && target !== event.currentTarget ? target : null;
  };
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (markup) {
      if (!markup.selecting) return;
      event.preventDefault();
      event.stopPropagation();
      const el = under(event);
      if (el) markup.onPick({ pick: describeElement(el, event.currentTarget), rect: boxIn(el, markup.stage.current) });
      return;
    }
    if (!picking || !onPick) return;
    // A link in a note must not leave the app while picking.
    event.preventDefault();
    event.stopPropagation();
    onPick(describeElement(target, event.currentTarget));
  };
  const onMove = (event: MouseEvent<HTMLDivElement>) => {
    if (!markup?.selecting) return;
    const el = under(event);
    if (!el) return markup.onHover(null);
    const b = boxIn(el, markup.stage.current);
    const s = markup.stage.current?.getBoundingClientRect();
    markup.onHover({ ...b, label: `${el.tagName.toLowerCase()}${oneWord(el.textContent ?? '') ? ` · ${oneWord(el.textContent ?? '')}` : ''}`, cx: event.clientX - (s?.left ?? 0), cy: event.clientY - (s?.top ?? 0) });
  };
  return (
    <div
      ref={wrap}
      className={`ck-file-page${picking || markup?.selecting ? ' ck-art-picking' : ''}${markup?.hold ? ' ck-art-held' : ''}`}
      data-testid="artifact-markdown"
      onClickCapture={onClick}
      onMouseMove={onMove}
      onMouseLeave={() => markup?.onHover(null)}
    >
      <ChatMarkdown text={content} />
    </div>
  );
}

export function ArtifactBody({
  kind,
  content,
  title,
  className,
  fit,
  picking = false,
  onPick,
  markup,
}: {
  kind: ArtifactKind;
  content: string;
  title: string;
  className?: string;
  fit?: boolean;
  /** The next click is a pick. */
  picking?: boolean;
  onPick?: (pick: ArtifactPick) => void;
  /** The mark-up bar's Select tool (replaces `picking`/`onPick`). */
  markup?: BodyMarkup;
}) {
  const t = useT();
  const page = useMemo(() => (kind === 'markdown' ? null : framePage(kind, content)), [kind, content]);
  if (page === null) return <MarkdownBody content={content} picking={picking} onPick={onPick} markup={markup} />;
  return (
    <SandboxFrame
      html={page.html}
      allowScripts={page.allowScripts}
      cdn={page.cdn}
      title={t('artifacts.frameLabel', { title })}
      className={className ?? 'ck-sandbox ck-sandbox--fill'}
      fit={fit}
      pickable={!!onPick || !!markup}
      picking={picking}
      onPick={onPick}
      markup={markup}
    />
  );
}
