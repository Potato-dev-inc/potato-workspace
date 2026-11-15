// A pairing link: a long text in a read-only box with a Copy button and what to know about it.
import { useState } from 'react';
import { useT } from '../../i18n';
import '../../styles/devices.css';

export function LinkBox({ link }: { link: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard
      ?.writeText(link)
      .then(() => setCopied(true))
      .catch(() => undefined);
  };
  return (
    <div className="dev-form">
      <label className="dev-field">
        <span>{t('devices.linkLabel')}</span>
        <textarea className="dev-link-box" readOnly value={link} onFocus={(e) => e.currentTarget.select()} data-testid="the-link" />
      </label>
      <div className="dev-row">
        <button type="button" className="dev-btn" onClick={copy} data-testid="copy-link">
          {copied ? t('devices.copied') : t('devices.copy')}
        </button>
      </div>
      <p className="dev-note">{t('devices.linkHelp')}</p>
    </div>
  );
}
