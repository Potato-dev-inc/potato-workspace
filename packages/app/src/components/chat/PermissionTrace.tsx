// What an answered permission question leaves in the conversation: one quiet line (a tick or a cross, "Allowed ·
// <what>"), not a ruled separator. A question still waiting reads "Waiting for you · <what>".
import { parseVerdict } from '../../lib/decisionCard';
import '../../styles/chat-decision-card.css';

function Icon({ tone }: { tone: 'allow' | 'deny' | 'wait' | 'note' }) {
  const path = tone === 'allow' ? 'M3.5 8.5l3 3 6-7' : tone === 'deny' ? 'M4 4l8 8M12 4l-8 8' : tone === 'wait' ? 'M8 4.5V8l2.5 1.5' : 'M4 8h8';
  return (
    <svg className="ck-trace-i" viewBox="0 0 16 16" aria-hidden="true">
      <path d={path} />
    </svg>
  );
}

export function PermissionTrace({ text }: { text: string }) {
  const v = parseVerdict(text);
  return (
    <div className="ck-trace" data-tone={v.tone} data-auto={v.auto ? '' : undefined} data-testid="permission-trace" title={v.auto ? text : undefined}>
      <Icon tone={v.tone} />
      <span className="ck-trace-tx">
        <b>{v.head}</b>
        {v.title && ` · ${v.title}`}
      </span>
    </div>
  );
}
