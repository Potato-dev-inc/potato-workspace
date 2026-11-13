// The thin orange line in a chat: "New since you looked · 3 answers · 5 files changed". The chat opens at it; it goes
// when the reader reaches the end. `JumpToLatest` is the button at the bottom while the line is showing.
import { useT } from '../../i18n';
import type { SinceReport } from '../../lib/chatSince';
import '../../styles/chat-ux.css';

export function SinceLine({ report }: { report: SinceReport }) {
  const t = useT();
  const bits: string[] = [];
  if (report.answers > 0) bits.push(t('chatUx.since.answers', { count: report.answers }));
  if (report.files > 0) bits.push(t('chatUx.since.files', { count: report.files }));
  if (bits.length === 0) bits.push(t('chatUx.since.activity'));
  return (
    <div className="ck-since" role="status" data-since data-testid="since-line">
      <span className="ck-since-text">
        {t('chatUx.since.title')} · {bits.join(' · ')}
      </span>
    </div>
  );
}

export function JumpToLatest({ onJump }: { onJump: () => void }) {
  const t = useT();
  return (
    <div className="ck-jump-wrap">
      <button type="button" className="ck-jump" data-testid="jump-latest" onClick={onJump}>
        {t('chatUx.since.jump')} ↓
      </button>
    </div>
  );
}
