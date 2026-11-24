// Inbox › Needs you: a request to borrow one of my agents waits for my answer, so it sits with the other waiting cards at the top
// (not under Team activity). Same answer card as before; the request text is another PC's, shown as plain text.
import { useState } from 'react';
import { useT } from '../../../i18n';
import { lendApi, type LendApi } from '../../../lib/lend';
import { IncomingRequestCard } from '../../lend/IncomingRequestCard';
import { useLend } from '../../lend/useLend';

export function AskedLends({ now, api = lendApi }: { now: number; api?: LendApi }) {
  const t = useT();
  const lend = useLend(api);
  // A request just answered leaves the list at once; the backend takes a few seconds to say it is no longer open.
  const [answered, setAnswered] = useState<readonly string[]>([]);
  const asked = lend.state?.requests_in.filter((r) => r.state === 'open') ?? [];
  // The card stays mounted (hidden) so a failed answer can bring it back with its reason.
  if (!lend.state || asked.every((r) => answered.includes(r.id))) return null;
  return (
    <ul className="ib-list" aria-label={t('inbox.needsYouList')} data-testid="inbox-asked-lends">
      {asked.map((r) => (
        <li key={r.id} data-asked-lend={r.id} hidden={answered.includes(r.id)}>
          <IncomingRequestCard request={r} state={lend.state!} api={api} now={now} onDone={lend.refresh} onAnswering={(sending) => setAnswered((ids) => (sending ? [...ids, r.id] : ids.filter((id) => id !== r.id)))} />
        </li>
      ))}
    </ul>
  );
}
