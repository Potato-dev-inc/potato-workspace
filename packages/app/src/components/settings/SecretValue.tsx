// A secret the app shows once (a new link secret, or one asked for with "Show secret"). It starts hidden as dots; the eye
// button shows or hides it, and Copy copies it without ever showing it. The value stays in this component's props only.
import { useState } from 'react';
import { useT } from '../../i18n';
import { errorSentence } from '../../lib/sayError';

const EYE_PROPS = { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;

const BTN = 'rounded-lg border border-pm-border px-3 py-1.5 text-xs hover:bg-pm-border/40';

function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg {...EYE_PROPS}>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
      {off && <path d="M4 4l16 16" />}
    </svg>
  );
}

export function SecretValue({ value, testId = 'stable-secret', copyLabel, onError, onHide }: { value: string; testId?: string; copyLabel?: string; onError?: (message: string) => void; /** Called when the eye hides the secret again: the owner can then forget the value. */ onHide?: () => void }) {
  const t = useT();
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch (e) {
      onError?.(errorSentence(e));
    }
  };
  return (
    <div className="stable-secret flex flex-wrap items-center gap-2" data-testid={`${testId}-row`}>
      <code data-testid={testId} data-hidden={shown ? undefined : 'true'} className="break-all font-mono text-xs">
        {shown ? value : '•'.repeat(Math.min(Math.max(value.length, 8), 24))}
      </code>
      <button
        type="button"
        className={BTN + ' inline-flex items-center'}
        data-testid={`${testId}-eye`}
        aria-pressed={shown}
        aria-label={shown ? t('tunnel.secretEyeHide') : t('tunnel.secretEyeShow')}
        title={shown ? t('tunnel.secretEyeHide') : t('tunnel.secretEyeShow')}
        onClick={() => {
          if (shown) onHide?.();
          setShown((v) => !v);
        }}
      >
        <EyeIcon off={shown} />
      </button>
      <button type="button" className={BTN} aria-label={copyLabel} onClick={() => void copy()}>
        {copied ? t('tunnel.secretCopied') : t('tunnel.secretCopy')}
      </button>
    </div>
  );
}
