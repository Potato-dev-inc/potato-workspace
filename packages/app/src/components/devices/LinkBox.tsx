// A pairing link, the way a person shares it: one Copy button and a picture to scan. The text itself is there for
// anyone who wants to read it, but it is folded away: nobody has to look at it, type it or understand it.
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { useT } from '../../i18n';
import '../../styles/devices.css';

export function LinkBox({ link }: { link: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const [picture, setPicture] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    // Black on white always: a camera reads that best, in both themes.
    try {
      QRCode.toString(link, { type: 'svg', margin: 1, errorCorrectionLevel: 'L', color: { dark: '#000000', light: '#ffffff' } })
        .then((svg) => alive && setPicture(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`))
        .catch(() => alive && setPicture(null));
    } catch {
      // No picture is not a problem: Copy still works.
    }
    return () => {
      alive = false;
    };
  }, [link]);
  const copy = () => {
    void navigator.clipboard
      ?.writeText(link)
      .then(() => setCopied(true))
      .catch(() => undefined);
  };
  return (
    <div className="dev-form dev-linkbox" data-testid="link-box">
      <div className="dev-row dev-linkbox-main">
        {picture && <img className="dev-qr" src={picture} alt={t('devices.qrAlt')} width={132} height={132} data-testid="link-qr" />}
        <div className="dev-grow">
          <button type="button" className="dev-btn is-primary" onClick={copy} data-testid="copy-link">
            {copied ? t('devices.copied') : t('devices.copyLink')}
          </button>
          <p className="dev-note">{t('devices.linkHelp')}</p>
        </div>
      </div>
      <details className="dev-link-text">
        <summary>{t('devices.linkAsText')}</summary>
        <textarea className="dev-link-box" readOnly value={link} onFocus={(e) => e.currentTarget.select()} aria-label={t('devices.linkLabel')} data-testid="the-link" />
      </details>
    </div>
  );
}
