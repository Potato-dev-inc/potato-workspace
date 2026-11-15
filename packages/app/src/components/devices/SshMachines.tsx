// Settings > Devices > "SSH machines": the machines saved with Add a device > Over SSH. Check again lists what is there; Remove
// forgets the machine here (nothing is changed on it). Text from a machine is shown as text only.
import { useCallback, useEffect, useState } from 'react';
import { useT } from '../../i18n';
import { errorSentence } from '../../lib/sayError';
import { checkLines, sshApi, sshStateSentence, type SshApi, type SshCheck, type SshHost } from '../../lib/ssh';
import '../../styles/devices.css';

export function SshMachines({ api = sshApi, refreshKey = 0 }: { api?: SshApi; refreshKey?: number }) {
  const t = useT();
  const [hosts, setHosts] = useState<SshHost[]>([]);
  const [checks, setChecks] = useState<Record<string, SshCheck | string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => {
    api
      .hosts()
      .then((h) => setHosts(Array.isArray(h) ? h : []))
      .catch(() => setHosts([]));
  }, [api]);
  useEffect(load, [load, refreshKey]);
  const again = (id: string) => {
    setBusy(id);
    api
      .checkSaved(id)
      .then((c) => setChecks((m) => ({ ...m, [id]: c })))
      .catch((e: unknown) => setChecks((m) => ({ ...m, [id]: errorSentence(e) })))
      .finally(() => {
        setBusy(null);
        load();
      });
  };
  const remove = (id: string) => {
    void api.remove(id).then(load, load);
  };
  return (
    <div data-testid="ssh-machines">
      <h4>{t('devices.ssh.list')}</h4>
      {hosts.length === 0 ? (
        <p className="dev-note" data-testid="ssh-empty">
          {t('devices.ssh.empty')}
        </p>
      ) : (
        <ul className="dev-list">
          {hosts.map((h) => {
            const c = checks[h.id];
            const problem = typeof c === 'string' ? c : c ? sshStateSentence(c) : null;
            return (
              <li key={h.id} data-testid={`ssh-host-${h.id}`}>
                <div className="dev-item">
                  <span className="dev-grow">
                    <b>{h.name}</b>
                    <small>
                      {h.user}@{h.host}
                      {h.port !== 22 ? `:${h.port}` : ''}
                      {h.os ? ` · ${h.os}` : ''}
                      {h.agents.length > 0 ? ` · ${h.agents.map((a) => a.label).join(', ')}` : ''}
                    </small>
                  </span>
                  <button type="button" className="dev-btn" disabled={busy !== null} onClick={() => again(h.id)} data-testid={`ssh-again-${h.id}`}>
                    {busy === h.id ? t('devices.ssh.checking') : t('devices.ssh.checkAgain')}
                  </button>
                  <button type="button" className="dev-btn" onClick={() => remove(h.id)} data-testid={`ssh-remove-${h.id}`}>
                    {t('devices.ssh.remove')}
                  </button>
                </div>
                {problem && (
                  <p className="dev-error" role="alert">
                    {problem}
                  </p>
                )}
                {c && typeof c !== 'string' && c.state === 'ok' && (
                  <ul className="dev-check-inline" data-testid={`ssh-list-${h.id}`}>
                    {checkLines(c).map((l) => (
                      <li key={l.id}>{l.found ? `✓ ${l.text}` : `– ${l.text}`}</li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
