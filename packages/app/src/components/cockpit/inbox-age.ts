// ONE way to say how long a card has waited, on every Inbox card: "now", "42s", "5m", "3h", "2d".
// No prefix ("asked", "waiting", "ran out") and no "ago": the card says what it is, the age says how old.
import { t } from '../../i18n';

/** The short form shown at the right edge of a card. */
export function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 5) return t('inbox.ageNow');
  if (s < 60) return t('inbox.shortSeconds', { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t('inbox.shortMinutes', { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t('inbox.shortHours', { n: h });
  return t('inbox.shortDays', { n: Math.floor(h / 24) });
}

/** The same age as a phrase, for the tooltip and screen readers: "2 minutes ago". */
export function agePhrase(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 5) return t('inbox.ageJustNow');
  if (s < 60) return t('inbox.agoSecond', { count: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t('inbox.agoMinute', { count: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t('inbox.agoHour', { count: h });
  return t('inbox.agoDay', { count: Math.floor(h / 24) });
}
