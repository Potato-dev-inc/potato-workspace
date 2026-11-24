// Add a computer (SSH): step 1 asks for the address (`user@host`; a port and a key file PATH sit under "More options") and Check runs a
// fixed read-only script over ssh. Step 2 says the machine answered, lists what is there, asks for a name, and the one button
// "Set it up" keeps the machine, puts the small program on it and pairs it with this PC (every step tried three times; progress shown as
// plain lines). If a step still fails it hands over: the fixed line to paste in a shell on the machine, Copy, Open a shell, Try again.
// No password is typed or stored here (the terminal asks for it), and the key file is only a path.
import { useRef, useState } from 'react';
import { useT } from '../../i18n';
import { errorSentence } from '../../lib/sayError';
import { checkLines, setupSentence, sshApi, sshFormReady, sshStateSentence, type SshApi, type SshCheck, type SshParts, type SshSetupFailure, type SshSetupProgress, type SshSetupStep } from '../../lib/ssh';
import '../../styles/devices.css';

/** `plain` (the Connect page): only the address and a name; the extra settings stay out. */
/** The latest state of each step, in the order the steps first appeared. */
export function stepLines(events: SshSetupProgress[]): { step: SshSetupStep; state: SshSetupProgress['state']; attempt: number }[] {
  const out: { step: SshSetupStep; state: SshSetupProgress['state']; attempt: number }[] = [];
  for (const e of events) {
    const at = out.findIndex((o) => o.step === e.step);
    if (at < 0) out.push({ step: e.step, state: e.state, attempt: e.attempt });
    else out[at] = { step: e.step, state: e.state, attempt: e.attempt };
  }
  return out;
}

export function SshForm({ api = sshApi, onSaved, onCancel, plain = false }: { api?: SshApi; onSaved: () => void; onCancel: () => void; plain?: boolean }) {
  const t = useT();
  const [target, setTarget] = useState('');
  const [port, setPort] = useState('22');
  const [keyFile, setKeyFile] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<'check' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SshCheck | null>(null);
  const [touched, setTouched] = useState(false);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [events, setEvents] = useState<SshSetupProgress[]>([]);
  const [failure, setFailure] = useState<SshSetupFailure | null>(null);
  const [copied, setCopied] = useState(false);
  const watching = useRef<string | null>(null);
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
  const setUp = async () => {
    setBusy('save');
    setError(null);
    setFailure(null);
    setEvents([]);
    let stop = () => {};
    try {
      let id = savedId;
      if (!id) {
        id = (await api.add(name.trim(), parts(), result)).id;
        setSavedId(id);
      }
      watching.current = id;
      stop = await api.watchSetup((p) => {
        if (p.id === watching.current) setEvents((all) => [...all, p]);
      });
      const done = await api.setup(id);
      if (done.ok) return onSaved();
      setFailure(done.failure);
    } catch (e) {
      setError(errorSentence(e));
    } finally {
      stop();
      setBusy(null);
    }
  };
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };
  const openShell = () => {
    if (savedId) void api.open(savedId, 'shell').catch((e: unknown) => setError(errorSentence(e)));
  };
  const problem = result ? sshStateSentence(result, plain) : null;
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
          {!plain && (
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
          )}
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
      {events.length > 0 && (
        <ul className="dev-check-inline" data-testid="ssh-setup-steps">
          {stepLines(events).map((l) => (
            <li key={l.step} data-testid={`ssh-step-${l.step}`}>
              {l.state === 'done' ? '✓ ' : ''}
              {l.state === 'retrying' ? t('devices.ssh.step.retry', { step: t(`devices.ssh.step.${l.step}`), n: l.attempt }) : t(`devices.ssh.step.${l.step}`)}
            </li>
          ))}
        </ul>
      )}
      {failure && (
        <div className="dev-check" role="alert" data-testid="ssh-setup-failed">
          <p className="dev-error">{setupSentence(failure)}</p>
          {failure.handoff && (
            <>
              <p className="dev-note">{t('devices.ssh.handoff.note')}</p>
              <code className="dev-handoff" data-testid="ssh-handoff-line">
                {failure.handoff}
              </code>
              <div className="dev-actions">
                <button type="button" className="dev-btn" onClick={() => copy(failure.handoff!)} data-testid="ssh-handoff-copy">
                  {copied ? t('devices.ssh.handoff.copied') : t('devices.ssh.handoff.copy')}
                </button>
                <button type="button" className="dev-btn" onClick={openShell} data-testid="ssh-handoff-shell">
                  {t('devices.ssh.handoff.shell')}
                </button>
              </div>
            </>
          )}
        </div>
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
          <button type="button" className="dev-btn is-primary" disabled={busy !== null} onClick={() => void setUp()} data-testid="ssh-save">
            {busy === 'save' ? t('devices.ssh.settingUp') : failure || savedId ? t('devices.ssh.tryAgain') : t('devices.ssh.save')}
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
