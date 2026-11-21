// Settings > Agents: one larger card per agent (mark, name, how it stands, sign-in, usage, Sign in / Sign out). The card is
// in AgentCard.tsx. A click on the name opens that agent's page.
import { useMemo } from 'react';
import { useT } from '../../../i18n';
import { useHost } from '../../../lib/host/context';
import { AgentCard, cardApisFor, useCardData, type CardApis } from './AgentCard';
import type { AgentRow } from './useAgentRows';

export function AgentList({ rows, onOpen, onCheck, apis: given }: { rows: AgentRow[]; onOpen: (agentId: string) => void; onCheck?: (agentId: string) => Promise<void>; apis?: CardApis }) {
  const t = useT();
  const host = useHost();
  const apis = useMemo(() => given ?? cardApisFor(host), [given, host]);
  const data = useCardData(apis);
  if (rows.length === 0) {
    return (
      <div className="st-row" data-testid="agent-list-empty">
        <div className="st-label">
          <span>{t('agentList.none')}</span>
          <small>{t('agentList.addAbove')}</small>
        </div>
      </div>
    );
  }
  // A <section>, not a plain div: the Settings list hides a row wrapper that holds no direct .st-row or section,
  // so a div of cards would never be drawn.
  return (
    <section className="ag-cards" data-testid="agent-cards" aria-label={t('agentList.cardsAria')}>
      {rows.map((row) => (
        <AgentCard key={row.id} row={row} accounts={data.accounts} usage={data.usage} logins={data.logins} apis={apis} signOut={apis.accounts.signOut} onOpen={onOpen} onCheck={onCheck} onChanged={data.refresh} />
      ))}
    </section>
  );
}
