// "Bring my chats", step 2: one agent's recent chats. Each row has a checkbox, a title, the folder, the date and the
// message count. A chat that was brought before says so and can be opened.
import { agoText, messageCount } from '../../lib/bringChats';
import type { BrowseRow } from '../../lib/chatImport';

export function BringChatRows({
  rows,
  picked,
  now,
  onToggle,
  onOpen,
}: {
  rows: BrowseRow[];
  picked: ReadonlySet<string>;
  now: number;
  onToggle: (session: string) => void;
  onOpen: (session: string) => void;
}) {
  return (
    <ul className="bc-rows" aria-label="Recent chats">
      {rows.map((row) => {
        const sub = [row.folder, agoText(row.updatedMs, now), row.error ? null : messageCount(row)].filter(Boolean).join(' · ');
        return (
          <li key={row.session} className="bc-row">
            <input
              type="checkbox"
              aria-label={`Pick ${row.title}`}
              checked={picked.has(row.session)}
              disabled={row.error !== null}
              onChange={() => onToggle(row.session)}
            />
            <div className="bc-row-main">
              <span className="bc-row-title">{row.title}</span>
              <span className="bc-row-sub">{sub}</span>
              {row.error && <span className="bc-row-sub">{row.error}</span>}
              {row.brought && <span className="bc-row-sub">Already brought</span>}
            </div>
            {row.brought && (
              <button type="button" className="bc-row-open" onClick={() => onOpen(row.session)}>
                Open
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
