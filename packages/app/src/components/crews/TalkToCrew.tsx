// "Change the crew by talking": type what to change, the front desk (the crew's lead agent) proposes it, and the canvas shows the
// crew before and after. Nothing changes until the person presses Apply; Undo puts the last change back. Routing only (who hands
// work to whom, and the routing rules): the app refuses anything else, whatever the agent says. A proposal is never saved by
// itself: Apply changes the canvas and the person saves it like any other change.
import { useState } from 'react';
import { useT } from '../../i18n';
import { crewErrorText, type Crew } from '../../lib/crews-api';
import { crewTalkApi, type CrewTalkApi, type TalkChange, type TalkOutcome } from '../../lib/crew-talk-api';
import { changedEdges, roleName, ruleLines, sameState, touchedRoles, type TalkView } from './talkModel';

export interface Shown {
  crew: Crew;
  changed: string[];
  touched: string[];
}

export function TalkToCrew({
  crew,
  rules,
  disabled,
  api = crewTalkApi,
  onShow,
  onApply,
}: {
  crew: Crew;
  rules: string;
  /** A ready-made crew: make a copy first. */
  disabled: boolean;
  api?: CrewTalkApi;
  /** What the canvas should draw while a proposal is open (null: the crew as it is). */
  onShow: (shown: Shown | null) => void;
  /** The person pressed Apply (or Undo): the canvas takes this crew and these rules. */
  onApply: (crew: Crew, rules: string) => void;
}) {
  const t = useT();
  const [request, setRequest] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<TalkOutcome | null>(null);
  const [base, setBase] = useState<{ crew: Crew; rules: string } | null>(null);
  const [view, setView] = useState<TalkView>('after');
  const [undo, setUndo] = useState<{ crew: Crew; rules: string; applied: { crew: Crew; rules: string } } | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const proposal = outcome?.status === 'proposal' && outcome.crew && outcome.routing_text !== null ? outcome : null;
  const stale = !!proposal && !!base && !sameState(base, { crew, rules });
  const canUndo = !!undo && sameState(undo.applied, { crew, rules });

  const show = (next: TalkView, p: TalkOutcome) => {
    setView(next);
    onShow(p.crew ? { crew: next === 'after' ? p.crew : (base?.crew ?? crew), changed: changedEdges(p.changes, next), touched: touchedRoles(p.changes) } : null);
  };

  const ask = async () => {
    if (!request.trim() || busy || disabled) return;
    setBusy(true);
    setError(null);
    setNote(null);
    setOutcome(null);
    onShow(null);
    try {
      const out = await api.talk(crew, rules, request);
      setOutcome(out);
      if (out.status === 'proposal' && out.crew) {
        setBase({ crew, rules });
        setView('after');
        onShow({ crew: out.crew, changed: changedEdges(out.changes, 'after'), touched: touchedRoles(out.changes) });
      }
    } catch (err) {
      setError(crewErrorText(err) || t('crewtalk.failed'));
    }
    setBusy(false);
  };

  const close = () => {
    setOutcome(null);
    onShow(null);
  };

  const apply = () => {
    if (!proposal || !proposal.crew || proposal.routing_text === null || stale) return;
    setUndo({ crew, rules, applied: { crew: proposal.crew, rules: proposal.routing_text } });
    onApply(proposal.crew, proposal.routing_text);
    close();
    setRequest('');
    setNote(t('crewtalk.applied'));
  };

  const revert = () => {
    if (!undo || !canUndo) return;
    onApply(undo.crew, undo.rules);
    setUndo(null);
    setNote(t('crewtalk.undone'));
  };

  const sentence = (c: TalkChange): string => {
    const name = (key: string) => roleName(base?.crew ?? crew, key);
    switch (c.kind) {
      case 'handoff_added':
        return t('crewtalk.change.handoffAdded', { from: name(c.from), to: name(c.to) });
      case 'handoff_removed':
        return t('crewtalk.change.handoffRemoved', { from: name(c.from), to: name(c.to) });
      case 'rule_added':
        return t('crewtalk.change.ruleAdded', { role: name(c.role), text: c.text });
      default:
        return t('crewtalk.change.ruleRemoved', { role: name(c.role), text: c.text });
    }
  };

  const lines = proposal && proposal.routing_text !== null && base ? ruleLines(base.rules, proposal.routing_text) : { added: [], removed: [] };

  return (
    <div className="crewc-talk" data-testid="talk-to-crew">
      <label className="crewc-field">
        <span>{t('crewtalk.label')}</span>
        <textarea rows={3} value={request} disabled={disabled || busy} maxLength={600} placeholder={t('crewtalk.placeholder')} onChange={(e) => setRequest(e.target.value)} />
      </label>
      <button type="button" className="crewc-btn crewc-btn--primary" disabled={disabled || busy || !request.trim()} onClick={() => void ask()}>
        {busy ? t('crewtalk.busy') : t('crewtalk.ask')}
      </button>
      <p className="crewc-hint">{disabled ? t('crewtalk.readonly') : t('crewtalk.note')}</p>
      {error ? (
        <p className="crewc-error" role="alert">
          {error}
        </p>
      ) : null}
      {outcome?.status === 'refused' ? (
        <p className="crewc-error" role="alert" data-testid="talk-refused">
          {outcome.message}
        </p>
      ) : null}
      {outcome?.status === 'nothing' ? <p className="crewc-hint">{outcome.message}</p> : null}
      {proposal && proposal.crew ? (
        <div className="crewc-way" aria-live="polite" data-testid="talk-proposal">
          <h4>{t('crewtalk.proposal')}</h4>
          {proposal.message ? <p>{proposal.message}</p> : null}
          <ul className="crewc-changes">
            {proposal.changes.map((c, i) => (
              <li key={i}>{sentence(c)}</li>
            ))}
          </ul>
          <div className="crewc-seg" role="group" aria-label={t('crewtalk.view')}>
            {(['before', 'after'] as const).map((id) => (
              <button key={id} type="button" aria-pressed={view === id} className={view === id ? 'is-on' : ''} onClick={() => show(id, proposal)}>
                {t(`crewtalk.${id}` as never)}
              </button>
            ))}
          </div>
          <p className="crewc-hint">{view === 'before' ? t('crewtalk.legendBefore') : t('crewtalk.legendAfter')}</p>
          {lines.added.length + lines.removed.length > 0 ? (
            <ul className="crewc-ruledif" aria-label={t('crewtalk.rules')}>
              {lines.removed.map((l) => (
                <li key={`r-${l}`} className="is-removed">
                  <span aria-hidden="true">− </span>
                  {l.replace(/^- /, '')}
                </li>
              ))}
              {lines.added.map((l) => (
                <li key={`a-${l}`} className="is-added">
                  <span aria-hidden="true">+ </span>
                  {l.replace(/^- /, '')}
                </li>
              ))}
            </ul>
          ) : null}
          {stale ? <p className="crewc-warn">{t('crewtalk.stale')}</p> : null}
          <div className="crewc-talk-actions">
            <button type="button" className="crewc-btn crewc-btn--primary" disabled={stale} onClick={apply}>
              {t('crewtalk.apply')}
            </button>
            <button type="button" className="crewc-btn" onClick={close}>
              {t('crewtalk.discard')}
            </button>
          </div>
          {outcome?.asked ? <p className="crewc-hint">{t('crewtalk.asked', { agent: outcome.asked })}</p> : null}
        </div>
      ) : null}
      {note ? (
        <p className="crewc-hint" role="status" data-testid="talk-note">
          {note}
          {canUndo ? (
            <>
              {' '}
              <button type="button" className="crewc-btn crewc-btn--small" onClick={revert}>
                {t('crewtalk.undo')}
              </button>
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
