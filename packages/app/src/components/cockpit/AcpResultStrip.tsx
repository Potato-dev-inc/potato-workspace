import type { AcpResult } from './acp-pane';

/** The compact result of a chat session's run, under its conversation: files changed and the agent's own summary. */
export function AcpResultStrip({ result }: { result: AcpResult }) {
  const facts = [
    result.files,
    result.checks.length > 0 ? `${result.checks.length} ${result.checks.length === 1 ? 'check' : 'checks'}` : null,
    result.questions.length > 0 ? `${result.questions.length} open ${result.questions.length === 1 ? 'question' : 'questions'}` : null,
  ].filter(Boolean);
  return (
    <section className="ck-acp-result" aria-label="Result" data-testid="acp-result">
      <span className="ck-caption">Result</span>
      {result.summary && <span className="ck-acp-result-text" title={result.summary}>{result.summary}</span>}
      {facts.length > 0 && (
        <span className="ck-acp-result-facts" title={result.paths.join('\n') || undefined}>
          {facts.join(' · ')}
        </span>
      )}
    </section>
  );
}
