// The log strip under the canvas's Live tab: the last few things that happened, newest last. "Time, who, what" in plain words
// ("Sonnet started: fix login test", "Reviewer needs you"). It is made from the helpers the front started, as the app sees them.
import { useT } from '../../i18n';
import { LOG_LINES } from '../../lib/workflow-live';

export interface LiveLine {
  key: string;
  at: number;
  text: string;
  kind: string;
}

export function LiveStrip({ log }: { log: ReadonlyArray<LiveLine> }) {
  const t = useT();
  const shown = log.slice(-LOG_LINES);
  return (
    <section className="crewc-logstrip" aria-label={t('crewcanvas.live.log')} data-testid="live-log">
      {shown.length === 0 ? (
        <p className="crewc-hint">{t('crewcanvas.live.log.empty')}</p>
      ) : (
        <ol className="crewc-loglist" aria-live="polite">
          {shown.map((line) => (
            <li key={line.key} data-kind={line.kind}>
              <time className="crewc-logtime">{new Date(line.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}</time>
              <span className="crewc-logtext" title={line.text}>
                {line.text}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
