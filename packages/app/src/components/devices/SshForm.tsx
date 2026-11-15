// Add a device > Over SSH, as in the founder-approved demo: step 1 asks for the address (`user@host`; a port and a key file PATH sit
// under "More options") and Check runs a fixed read-only script over ssh. Step 2 says the machine answered, lists what is there
// (system, git, node, each agent), asks for a name, and "Add device" keeps it. Nothing is installed on the machine, no password is
// typed or stored here (the terminal asks for it), and the key file is only a path. A failed check says why, in its own words.
import { useState } from 'react';
import { useT } from '../../i18n';
import { errorSentence } from '../../lib/sayError';
import { checkLines, sshApi, sshFormReady, sshStateSentence, type SshApi, type SshCheck, type SshParts } from '../../lib/ssh';
import '../../styles/devices.css';

export function SshForm({ api = sshApi, onSaved, onCancel }: { api?: SshApi; onSaved: () => void; onCancel: () => void }) {
  const t = useT();
  const [target, setTarget] = useState('');
  const [port, setPort] = useState('22');
  const [keyFile, setKeyFile] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<'check' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SshCheck | null>(null);
  const [touched, setTouched] = useState(false);
  const ready = sshFormReady(target, port);
  const parts = (): SshParts => ({ target: target.trim(), ...(port.trim() ? { port: Number(port.trim()) } : {}), ...(keyFile.trim() ? { keyFile: keyFile.trim() } : {}) });
  const ok = result?.state === 'ok';
  const edit = (set: (v: string) => void) => (e: { target: { value: string } }) => {
    set(e.target.value);
    setResult(null);
  };
  const runCheck = () => {
    if (!ready) {
      setTouched(true);
      return;
    }
    setBusy('check');
    setError(null);
    api
      .check(parts())
      .then((c) => {
        setResult(c);
        if (c.state === 'ok' && !name.trim()) setName(target.trim().split('@').pop() ?? '');
      })
      .catch((e: unknown) => setError(errorSentence(e)))
      .finally(() => setBusy(null));
  };
  const save = () => {
    setBusy('save');
    setError(null);
    api
      .add(name.trim(), parts(), result)
      .then(() => onSaved())
      .catch((e: unknown) => {
        setError(errorSentence(e));
        setBusy(null);
      });
  };
  const problem = result ? sshStateSentence(result) : null;
  return (
    <div className="dev-form" data-testid="ssh-form">
      {!ok && (
        <>
          <p className="dev-note">{t('devices.ssh.intro')}</p>
          <label className="dev-field">
            <span>{t('devices.ssh.targetLabel')}</span>
            <input type="text" value={target} placeholder={t('devices.ssh.targetPlaceholder')} autoCapitalize="none" spellCheck={false} onChange={edit(setTarget)} data-testid="ssh-target" />
          </label>
          {touched && !ready && (
            <p className="dev-error" role="alert" data-testid="ssh-bad-address">
              {t('devices.ssh.badAddress')}
            </p>
          )}
          <details className="dev-more">
            <summary>{t('devices.ssh.more')}</summary>
            <label className="dev-field">
              <span>{t('devices.ssh.portLabel')}</span>
              <input type="text" inputMode="numeric" value={port} onChange={edit(setPort)} data-testid="ssh-port" />
            </label>
            <label className="dev-field">
              <span>{t('devices.ssh.keyLabel')}</span>
              <input type="text" value={keyFile} placeholder={t('devices.ssh.keyPlaceholder')} spellCheck={false} onChange={edit(setKeyFile)} data-testid="ssh-key" />
            </label>
          </details>
          <p className="dev-note">{t('devices.ssh.keyHelp')}</p>
        </>
      )}
      {error && (
        <p className="dev-error" role="alert">
          {error}
        </p>
      )}
      {problem && (
        <p className="dev-error" role="alert" data-testid={`ssh-state-${result!.state}`}>
          {problem}
        </p>
      )}
      {result && ok && (
        <div className="dev-check" data-testid="ssh-check-list">
          <p>
            <b>{t('devices.ssh.answered', { address: target.trim() })}</b>
          </p>
          <ul>
            {result.os && (
              <li className="is-found" data-testid="ssh-os">
                {t('devices.ssh.os', { os: result.os })}
              </li>
            )}
            {checkLines(result).map((l) => (
              <li key={l.id} className={l.found ? 'is-found' : 'is-missing'} data-testid={`ssh-found-${l.id}`}>
                {l.text}
              </li>
            ))}
          </ul>
          <label className="dev-field">
            <span>{t('devices.ssh.nameLabel')}</span>
            <input type="text" value={name} placeholder={t('devices.ssh.namePlaceholder')} onChange={(e) => setName(e.target.value)} data-testid="ssh-name" />
          </label>
          <p className="dev-note">{t('devices.ssh.keyHelp')}</p>
        </div>
      )}
      <div className="dev-actions">
        <button type="button" className="dev-btn" onClick={onCancel}>
          {t('devices.cancel')}
        </button>
        {ok ? (
          <button type="button" className="dev-btn is-primary" disabled={busy !== null} onClick={save} data-testid="ssh-save">
            {t('devices.ssh.save')}
          </button>
        ) : (
          <button type="button" className="dev-btn is-primary" disabled={busy !== null} onClick={runCheck} data-testid="ssh-check">
            {busy === 'check' ? t('devices.ssh.checking') : t('devices.ssh.check')}
          </button>
        )}
      </div>
    </div>
  );
}
