// The demo registry: demo name -> a small component. Each demo is a few plain boxes (markup.ts) styled by demos.css.
// The base style is the finished picture (the "still"); the `play` prop adds the 5s loop. An unknown name draws a
// plain tile (never a crash, never an empty box).
import type { ComponentType, CSSProperties } from 'react';
import { useT } from '../../i18n';
import type { Area } from '../types';
import { DEMO_BOXES } from './markup';
import './demos.css';

export interface DemoProps {
  play: boolean;
  /** The screen-reader label; the picture has no text. */
  label?: string;
}

function parseStyle(text: string | undefined): CSSProperties | undefined {
  if (!text) return undefined;
  const out: Record<string, string> = {};
  for (const part of text.split(';')) {
    const at = part.indexOf(':');
    if (at < 0) continue;
    const prop = part.slice(0, at).trim().replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    out[prop] = part.slice(at + 1).trim();
  }
  return out as CSSProperties;
}

/** `<i class="a b" style="top:1%"></i>...` (trusted, static) as class + style pairs. */
export function parseBoxes(markup: string): { cls: string; style?: CSSProperties }[] {
  const boxes: { cls: string; style?: CSSProperties }[] = [];
  for (const m of markup.matchAll(/<i class="([^"]*)"(?: style="([^"]*)")?><\/i>/g)) boxes.push({ cls: m[1], style: parseStyle(m[2]) });
  return boxes;
}

function makeDemo(name: string): ComponentType<DemoProps> {
  const boxes = parseBoxes(DEMO_BOXES[name] ?? '');
  function Demo({ play, label }: DemoProps) {
    const t = useT();
    return (
      <div className={`wn-demo d-${name}${play ? ' play' : ''}`} role="img" aria-label={label ?? t('whatsnew.demoLabel')} data-demo={name} data-playing={play ? 'true' : 'false'}>
        {boxes.map((b, i) => (
          <i key={i} className={b.cls} style={b.style} />
        ))}
      </div>
    );
  }
  Demo.displayName = `Demo(${name})`;
  return Demo;
}

export const DEMOS: Record<string, ComponentType<DemoProps>> = Object.fromEntries(Object.keys(DEMO_BOXES).map((name) => [name, makeDemo(name)]));

/** The tile for a demo name nobody registered: the area's initial in a quiet box. */
function Fallback({ area, label }: { area?: Area; label?: string }) {
  const t = useT();
  return (
    <div className="wn-demo d-fallback" role="img" aria-label={label ?? t('whatsnew.demoLabel')} data-demo="fallback">
      <span className="wn-fallback-mark" aria-hidden="true">
        {(area ?? 'Chat').slice(0, 1)}
      </span>
    </div>
  );
}

/** One demo by name, or the fallback tile. */
export function Demo({ name, play, area, label }: { name: string; play: boolean; area?: Area; label?: string }) {
  const Comp = DEMOS[name];
  return Comp ? <Comp play={play} label={label} /> : <Fallback area={area} label={label} />;
}
