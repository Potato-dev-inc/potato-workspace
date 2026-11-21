// "My domain": the small sheet where a person types the web address they already point at this PC. One field, the address to
// point it at (with one plain sentence), a Check that asks the address itself, and Save. Nothing here is technical: the
// words are "web address", "point it at this PC", "reaches this PC".
import { useRef, useState } from 'react';
import { useDismissable } from '../../hooks/useDismissable';
import { useT } from '../../i18n';
import { normalizeOwnDomain, parsePhonePort } from '../../lib/own-domain';
import { domainResultText } from '../../lib/linkChecklist';
import { errorSentence } from '../../lib/sayError';
import type { TunnelConnectionTest } from '../../lib/tauri-types';

type Check = { state: 'idle' } | { state: 'checking' } | { state: 'ok' } | { state: 'bad'; message: string; reason?: string | null; http?: number | null };

export function OwnDomainSheet({
  initial,
  localPort,
  chosenPort = null,
  onSavePort,
  check,
  onSave,
  onClose,
}: {
  /** The saved address, when this is "Edit". */
  initial: string;
  /** The port the phone server really listens on, or null when it is not running. */
  localPort: number | null;
  /** The port the person chose for the phone server (used from the next start), or null for automatic. */
  chosenPort?: number | null;
  /** Saves the port on this PC (null = automatic). Absent when the app cannot (then there is no port field). */
  onSavePort?: (port: number | null) => Promise<void>;
  /** Asks the address itself; absent when the app cannot (then there is no Check button). */
  check?: (address: string) => Promise<TunnelConnectionTest>;
  onSave: (url: string) => Promise<void>;
  onClose: () => void;
}) {
  const t = useT();
  const [typed, setTyped] = useState(initial.replace(/^https:\/\//, ''));
  const [touched, setTouched] = useState(false);
  const [result, setResult] = useState<Check>({ state: 'idle' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [chosen, setChosen] = useState<number | null>(chosenPort);
  const [editingPort, setEditingPort] = useState(false);
  const [portTyped, setPortTyped] = useState('');
  const [portBusy, setPortBusy] = useState(false);
  const [portError, setPortError] = useState<string | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const parsed = normalizeOwnDomain(typed);
  const portParsed = parsePhonePort(portTyped);
  // What to point the address at: the port chosen here (used after a restart) or the one the app uses right now.
  const shownPort = chosen ?? localPort;
  const pending = chosen !== null && chosen !== localPort;
  const local = shownPort ? `http://127.0.0.1:${shownPort}` : null;
  const applyPort = (port: number | null) => {
    if (!onSavePort || portBusy) return;
    setPortBusy(true);
    setPortError(null);
    void onSavePort(port)
      .then(() => {
        setChosen(port);
        setEditingPort(false);
      })
      .catch((e: unknown) => setPortError(errorSentence(e)))
      .finally(() => setPortBusy(false));
  };
  useDismissable(true, { inside: [sheetRef], ignore: ['focus', 'blur', 'scroll'], onDismiss: onClose });

  const edit = (value: string) => {
    setTyped(value);
    setResult({ state: 'idle' });
    setError(null);
  };
  const runCheck = () => {
    if (!parsed.ok || !check) return;
    setResult({ state: 'checking' });
    void Promise.resolve()
      .then(() => check(parsed.url))
      .then((r) => setResult(r.ok ? { state: 'ok' } : { state: 'bad', message: r.message, reason: r.reason ?? null, http: r.http_status }))
      .catch((e: unknown) => setResult({ state: 'bad', message: errorSentence(e) }));
  };
  const save = () => {
    if (!parsed.ok || saving) return;
    setSaving(true);
    setError(null);
    void onSave(parsed.url)
      .catch((e: unknown) => setError(errorSentence(e)))
      .finally(() => setSaving(false));
  };
  const copy = () => {
    if (!local) return;
    try {
      void navigator.clipboard?.writeText(local).then(() => setCopied(true), () => undefined);
    } catch {
      /* no clipboard here */
    }
  };
  const problem = touched && !parsed.ok && typed.trim() ? t(parsed.error) : null;

  return (
    <div className="cx-scrim" data-testid="own-domain-sheet">
      <div className="cx-sheet" role="dialog" aria-label={t('connect.domain.title')} ref={sheetRef}>
        <div className="cx-sheet-head">
          <h3>{t('connect.domain.title')}</h3>
          <button type="button" className="cx-btn cx-quiet" aria-label={t('connect.close')} onClick={onClose}>
            ×
          </button>
        </div>
        <p className="cx-note">{t('connect.domain.lead')}</p>
        <label className="cx-field">
          <span>{t('connect.domain.field')}</span>
          <input
            className="cx-input"
            data-testid="own-domain-input"
            type="text"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="phone.example.com"
            value={typed}
            onChange={(e) => edit(e.target.value)}
            onBlur={() => setTouched(true)}
          />
        </label>
        {problem && (
          <p className="cx-note" role="alert" data-testid="own-domain-problem">
            {problem}
          </p>
        )}
        <div className="cx-field">
          <span>{t('connect.domain.pointAt')}</span>
          {local ? (
            <div className="cx-row-actions">
              <code className="cx-link-text" data-testid="own-domain-local">
                {local}
              </code>
              <button type="button" className="cx-btn" data-testid="own-domain-copy" onClick={copy}>
                {copied ? t('connect.thisPc.copied') : t('connect.thisPc.copy')}
              </button>
              {onSavePort && !editingPort && (
                <button
                  type="button"
                  className="cx-btn"
                  data-testid="own-domain-port-edit"
                  onClick={() => {
                    setPortTyped(shownPort ? String(shownPort) : '');
                    setPortError(null);
                    setEditingPort(true);
                  }}
                >
                  {t('connect.domain.portEdit')}
                </button>
              )}
            </div>
          ) : (
            <p className="cx-note" data-testid="own-domain-local-wait">
              {t('connect.domain.notRunning')}
            </p>
          )}
          {onSavePort && editingPort && (
            <div className="cx-row-actions" data-testid="own-domain-port-editor">
              <input
                className="cx-input"
                data-testid="own-domain-port"
                type="text"
                inputMode="numeric"
                spellCheck={false}
                aria-label={t('connect.domain.portField')}
                value={portTyped}
                onChange={(e) => {
                  setPortTyped(e.target.value);
                  setPortError(null);
                }}
              />
              <button type="button" className="cx-btn cx-primary" data-testid="own-domain-port-apply" disabled={!portParsed.ok || portParsed.port === null || portBusy} onClick={() => portParsed.ok && applyPort(portParsed.port)}>
                {t('connect.domain.portApply')}
              </button>
              <button type="button" className="cx-btn" data-testid="own-domain-port-auto" disabled={portBusy} onClick={() => applyPort(null)}>
                {t('connect.domain.portAuto')}
              </button>
              <button type="button" className="cx-btn cx-quiet" data-testid="own-domain-port-cancel" onClick={() => setEditingPort(false)}>
                {t('connect.domain.portCancel')}
              </button>
            </div>
          )}
          {onSavePort && editingPort && !portParsed.ok && (
            <p className="cx-note" role="alert" data-testid="own-domain-port-problem">
              {t(portParsed.error)}
            </p>
          )}
          {portError && (
            <p className="cx-note" role="alert" data-testid="own-domain-port-error">
              {portError}
            </p>
          )}
          {pending && (
            <p className="cx-note" data-testid="own-domain-port-pending">
              {t('connect.domain.portPending')}
            </p>
          )}
          <p className="cx-note">{t('connect.domain.how')}</p>
        </div>
        <div className="cx-row-actions">
          {check && (
            <button type="button" className="cx-btn" data-testid="own-domain-check" disabled={!parsed.ok || result.state === 'checking'} onClick={runCheck}>
              {result.state === 'checking' ? t('connect.domain.checkingBtn') : t('connect.domain.check')}
            </button>
          )}
          <button type="button" className="cx-btn cx-primary" data-testid="own-domain-save" disabled={!parsed.ok || saving} onClick={save}>
            {t('connect.domain.save')}
          </button>
        </div>
        {result.state === 'ok' && (
          <p className="cx-note" role="status" data-testid="own-domain-result">
            {t('connect.domain.reached')}
          </p>
        )}
        {result.state === 'bad' && (
          <p className="cx-note" role="status" data-testid="own-domain-result">
            {result.reason && parsed.ok ? domainResultText(t, result.reason, result.http, parsed.url.slice(8), localPort ? `http://127.0.0.1:${localPort}` : '') : result.message}
          </p>
        )}
        {error && (
          <p className="cx-note" role="alert" data-testid="own-domain-error">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
