// "Files come back": when the last reply of a chat on another device ends with `potato-result: <path>` (see
// lib/resultFile.ts), this card offers `Get it`. It reads the chat every few seconds while open, and again when that
// device says something changed. The root is the chat's own folder (same rule as Open folder). The far device checks
// the path; names and errors are untrusted text.
import { useEffect, useState } from 'react';
import { useT } from '../../i18n';
import { isFarError, lastPart, pickRoot } from '../../lib/deviceFiles';
import { clipText, devicesApi, type Device, type DevicesApi } from '../../lib/devices';
import { resultFileOf } from '../../lib/resultFile';
import { ExistsQuestion, TransferRow } from './TransferRow';
import { useFileOps, useTransfers } from './useFileOps';
import '../../styles/devices.css';

export const GET_IT_POLL_MS = 8000;

export function GetItCard({ device, paneId, cwd = '', api = devicesApi }: { device: Device; paneId: string; cwd?: string; api?: DevicesApi }) {
  const t = useT();
  const node = device.node;
  const [file, setFile] = useState<string | null>(null);
  const ops = useFileOps();
  const transfers = useTransfers(api, node);
  const online = device.state === 'online';

  useEffect(() => {
    if (!online) return;
    let live = true;
    const read = () =>
      api
        .request(node, 'GET', `/panes/${encodeURIComponent(paneId)}/chat`)
        .then((res) => {
          if (!live || res.status >= 300) return;
          setFile(resultFileOf((res.body as { items?: unknown } | null)?.items));
        })
        .catch(() => undefined);
    void read();
    const timer = window.setInterval(() => void read(), GET_IT_POLL_MS);
    let off: (() => void) | undefined;
    api
      .onEvent((ev) => {
        if (ev.node === node && ev.frame.includes(paneId)) void read();
      })
      .then((u) => (live ? (off = u) : u()))
      .catch(() => undefined);
    return () => {
      live = false;
      window.clearInterval(timer);
      off?.();
    };
  }, [api, node, paneId, online]);

  if (file === null) return null;
  const get = () => {
    ops.run(async (mode) => {
      const r = await api.filesRoots(node);
      if (isFarError(r)) return r;
      const root = pickRoot(Array.isArray(r.roots) ? r.roots : [], lastPart(cwd));
      if (root === null) return { ok: false as const, error: t('devices.files.noRoots', { name: clipText(device.name, 40) }) };
      return api.filesCopy({ node, root, paths: [file], on_exists: mode });
    });
  };
  const mine = ops.lastId === null ? undefined : transfers.find((x) => x.id === ops.lastId);
  return (
    <div className="dev-getit" data-testid="get-it-card">
      <p>{t('devices.getit.text', { name: clipText(device.name, 40), file: clipText(lastPart(file), 120) })}</p>
      <div className="dev-row">
        <button type="button" className="dev-btn is-primary" disabled={ops.busy || mine?.state === 'running'} onClick={get} data-testid="get-it">
          {t('devices.getit.button')}
        </button>
      </div>
      <ExistsQuestion ops={ops} />
      {ops.error && (
        <p className="dev-error" role="alert" data-testid="get-it-error">
          {ops.error}
        </p>
      )}
      {mine && (
        <ul className="dev-list">
          <TransferRow transfer={mine} api={api} />
        </ul>
      )}
    </div>
  );
}
