// Text from the backend that may mark a command with backticks ("Run `claude` and log in"). The marked part shows as
// inline code; the backticks themselves never show.
import type { ReactNode } from 'react';

export function codeParts(text: string): { code: boolean; text: string }[] {
  return text.split('`').map((part, i) => ({ code: i % 2 === 1, text: part })).filter((p) => p.text.length > 0);
}

export function CodeText({ text }: { text: string }): ReactNode {
  return codeParts(text).map((p, i) => (p.code ? <code key={i}>{p.text}</code> : <span key={i}>{p.text}</span>));
}
