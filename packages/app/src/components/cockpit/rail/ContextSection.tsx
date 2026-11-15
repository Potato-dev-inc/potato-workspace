// Context: how full the agent's window is. One row: "48% used", a thin bar and "96k of 200k". When the agent does not
// report its window we say so; we never guess.
import { useT } from '../../../i18n';
import type { UsageItem } from '../../../lib/sessionChatModel';
import { RailSection } from './RailSection';
import { formatTokens, readContext } from './railFormat';

/** Under 60% the bar is green, 60 to 84% amber, 85% and over the attention colour. */
export function contextTone(percent: number): 'ok' | 'mid' | 'high' {
  return percent >= 85 ? 'high' : percent >= 60 ? 'mid' : 'ok';
}

export function ContextSection({ usage, fresh }: { usage: UsageItem | null; /** The chat has no turns yet. */ fresh: boolean }) {
  const t = useT();
  const ctx = readContext(usage);
  if (!ctx) {
    return (
      <RailSection id="ctx" title={t('rail.ctx.title')} summary={fresh ? '0%' : undefined}>
        {fresh ? (
          <div className="rp-row is-empty">
            <span className="rp-k">{t('rail.ctx.used', { percent: 0 })}</span>
            <span className="rp-bar" aria-hidden="true">
              <b style={{ width: '0%' }} />
            </span>
          </div>
        ) : (
          <div className="rp-row is-empty">{t('rail.ctx.unknown')}</div>
        )}
      </RailSection>
    );
  }
  const tip = `Input ${ctx.input.toLocaleString('en-US')} tokens, output ${ctx.output.toLocaleString('en-US')} tokens`;
  const free = Math.max(0, ctx.window - ctx.used);
  return (
    <RailSection id="ctx" title={t('rail.ctx.title')} summary={`${ctx.percent}%`}>
      <div className="rp-row" title={tip}>
        <span className="rp-k">{t('rail.ctx.used', { percent: ctx.percent })}</span>
        <span className={`rp-bar is-${contextTone(ctx.percent)}`} role="meter" aria-label={t('rail.ctx.title')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={ctx.percent}>
          <b style={{ width: `${ctx.percent}%` }} />
        </span>
        <span className="rp-v is-dim">{ctx.used === 0 ? t('rail.ctx.free', { window: formatTokens(free) }) : t('rail.ctx.of', { used: formatTokens(ctx.used), window: formatTokens(ctx.window) })}</span>
      </div>
    </RailSection>
  );
}
