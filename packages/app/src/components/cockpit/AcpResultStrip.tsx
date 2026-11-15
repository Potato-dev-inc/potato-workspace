import { useState } from 'react';
import { useT } from '../../i18n';
import type { AcpResult } from './acp-pane';
import { ThenSheet } from './routines/ThenSheet';

/**
 * The compact result of a chat session's run, under its conversation: files changed and the agent's own summary.
 * With a `paneId` it also has "Then…": add a chain step that runs when this chat finishes (the sheet opens under the strip).
 */
export function AcpResultStrip({ result, paneId, cwd, onNotify }: { result: AcpResult; paneId?: string; cwd?: string; onNotify?: (text: string) => void }) {
  const t = useT();
  const [thenOpen, setThenOpen] = useState(false);
  const facts = [
    result.files,
    result.checks.length > 0 ? `${result.checks.length} ${result.checks.length === 1 ? 'check' : 'checks'}` : null,
    result.questions.length > 0 ? `${result.questions.length} open ${result.questions.length === 1 ? 'question' : 'questions'}` : null,
  ].filter(Boolean);
  return (
    <>
      <section className="ck-acp-result" aria-label="Result" data-testid="acp-result">
        <span className="ck-caption">Result</span>
        {result.summary && <span className="ck-acp-result-text" title={result.summary}>{result.summary}</span>}
        {facts.length > 0 && (
          <span className="ck-acp-result-facts" title={result.paths.join('\n') || undefined}>
            {facts.join(' · ')}
          </span>
        )}
        {paneId && !thenOpen && (
          <button type="button" className="ck-btn ck-btn--plain ck-acp-result-then" title={t('routines.then.tip')} onClick={() => setThenOpen(true)}>
            {t('routines.then.button')}
          </button>
        )}
      </section>
      {paneId && thenOpen && (
        <ThenSheet
          paneId={paneId}
          cwd={cwd ?? ''}
          onClose={() => setThenOpen(false)}
          onAdded={() => {
            setThenOpen(false);
            onNotify?.(t('routines.then.added'));
          }}
        />
      )}
    </>
  );
}
