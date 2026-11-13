// Settings > Orchestrator & Models > Model Bridge (Labs `model_bridge_enabled`): connect a model service with a key,
// then add it to Codex with one click (a preview, a backup, Undo). The key is typed once, goes straight to the system
// key store, and is cleared from this window the moment it is sent. Nothing here can read a key back.
import { useCallback, useEffect, useRef, useState } from 'react';
import { t, useT } from '../../../i18n';
import { keySavedLine, modelBridgeApi, plainError, type ModelBridgeApi, type ModelBridgeList, type ModelBridgePreview, type ModelBridgeService } from '../../../lib/model-bridge';
import type { RowDef } from '../model';
import { Btn, FieldInput, FieldLabel, FieldSelect, Note, SettingBlock } from '../settings-ui';

/** An example address in the empty field: the same in every language. */
const EXAMPLE_URL = 'https://example.com/v1';

interface Props {
  api?: ModelBridgeApi;
}

/** What the row is doing about Codex for one service. */
type CodexStep = { kind: 'preview'; service: ModelBridgeService; preview: ModelBridgePreview } | { kind: 'done'; id: string; message: string };

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // No clipboard here: the line is still shown, so it can be selected by hand.
  }
}

export function ModelBridge({ api = modelBridgeApi }: Props) {
  const t = useT();
  const [data, setData] = useState<ModelBridgeList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [pick, setPick] = useState('');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  // The pasted key lives only in this ref-backed field while typing. It is cleared as soon as it is sent.
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<CodexStep | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const next = await api.list();
      if (alive.current) setData(next);
    } catch (e) {
      if (alive.current) setError(plainError(e));
    }
  }, [api]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => {
      alive.current = false;
    };
  }, [refresh]);

  if (!data) {
    return error ? <Note role="alert">{error}</Note> : <Note>{t('teamPage.loading')}</Note>;
  }

  const connected = data.adapters.filter((a) => a.keySaved);
  const chosen = data.adapters.find((a) => a.id === pick) ?? null;
  const needsName = chosen?.blank === true;
  const canSave = !busy && chosen !== null && key.trim() !== '' && (!needsName || (name.trim() !== '' && url.trim() !== ''));

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(plainError(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const openConnect = () => {
    setConnecting(true);
    setStatus(null);
    setError(null);
    setPick((data.adapters.find((a) => !a.keySaved && !a.blank) ?? data.adapters[0])?.id ?? '');
  };

  const closeConnect = () => {
    setConnecting(false);
    setKey('');
    setName('');
    setUrl('');
  };

  const saveKey = () =>
    run(async () => {
      if (!chosen) return;
      const id = needsName ? await api.addCustom(name, url) : chosen.id;
      const sentKey = key;
      setKey('');
      const where = await api.saveKey(id, sentKey);
      closeConnect();
      setStatus(keySavedLine(where));
      await refresh();
    });

  const remove = (s: ModelBridgeService) =>
    run(async () => {
      await api.remove(s.id);
      setStep(null);
      setStatus(t('modelBridge.removed', { name: s.displayName, store: data.storageLabel }));
      await refresh();
    });

  const showPreview = (s: ModelBridgeService) =>
    run(async () => {
      const preview = await api.preview(s.id);
      setStatus(null);
      setStep({ kind: 'preview', service: s, preview });
    });

  const add = (s: ModelBridgeService) =>
    run(async () => {
      const done = await api.apply(s.id);
      setStep({ kind: 'done', id: s.id, message: done.message });
      await refresh();
    });

  const undo = (s: ModelBridgeService) =>
    run(async () => {
      const done = await api.undo(s.id);
      setStep(null);
      setStatus(done.message);
      await refresh();
    });

  return (
    <SettingBlock
      label={t('settings.row.model-bridge.label')}
      description={t('settings.row.model-bridge.hint')}
    >
      {!data.secure && <Note role="alert">{t('modelBridge.noStore')}</Note>}

      {connected.length > 0 && (
        <ul className="st-mb-list" aria-label={t('modelBridge.connected')}>
          {connected.map((s) => {
            const inCodex = s.applied !== null;
            return (
              <li key={s.id} className="st-mb-item" data-service={s.id}>
                <div className="st-mb-name">
                  {s.displayName}
                  <small>{inCodex ? t('modelBridge.readyInCodex') : t('agentList.ready')}</small>
                  {s.needsReview && s.note && <small>{s.note}</small>}
                </div>
                {inCodex ? (
                  <Btn small disabled={busy} onClick={() => void undo(s)} aria-label={t('modelBridge.undoAria', { name: s.displayName })}>
                    {t('pack.undo')}
                  </Btn>
                ) : (
                  <Btn small disabled={busy} onClick={() => void showPreview(s)} aria-label={t('modelBridge.useAria', { name: s.displayName })}>
                    {t('modelBridge.use')}
                  </Btn>
                )}
                <Btn small disabled={busy} onClick={() => void remove(s)} aria-label={t('keepGoing.removeLabel', { label: s.displayName })}>
                  {t('settings.remove')}
                </Btn>
              </li>
            );
          })}
        </ul>
      )}

      {step?.kind === 'preview' && (
        <div className="st-mb-card" role="group" aria-label={t('modelBridge.preview')}>
          <p>{step.preview.title}</p>
          <pre aria-label={t('modelBridge.willAdd')}>{step.preview.lines.join('\n')}</pre>
          <p>{t('modelBridge.addedTo', { path: step.preview.configPath })}</p>
          <p>
            {t('modelBridge.setFirst')}
            <br />
            <code>{step.preview.envLine}</code>
          </p>
          <div className="st-mb-actions">
            <Btn primary disabled={busy} onClick={() => void add(step.service)}>
              {t('keepGoing.add')}
            </Btn>
            <Btn disabled={busy} onClick={() => setStep(null)}>
              {t('lend.cancel')}
            </Btn>
            <Btn small onClick={() => void copyText(step.preview.envLine)}>
              {t('modelBridge.copyVar')}
            </Btn>
          </div>
        </div>
      )}

      {step?.kind === 'done' && (
        <div className="st-mb-card" role="status">
          <p>{step.message}</p>
          <p>{t('modelBridge.doneNote')}</p>
          <div className="st-mb-actions">
            <Btn
              small
              disabled={busy}
              onClick={() => {
                const s = data.adapters.find((a) => a.id === step.id);
                if (s) void undo(s);
              }}
            >
              {t('pack.undo')}
            </Btn>
            <Btn
              small
              onClick={() => {
                const s = data.adapters.find((a) => a.id === step.id);
                if (s) void copyText(s.envLine);
              }}
            >
              {t('modelBridge.copyVar')}
            </Btn>
          </div>
        </div>
      )}

      {!connecting && (
        <div className="st-mb-actions">
          <Btn primary={connected.length === 0} disabled={busy || !data.secure} onClick={openConnect}>
            {t('modelBridge.connect')}
          </Btn>
        </div>
      )}

      {connecting && (
        <div className="st-mb-form">
          <div>
            <FieldLabel>{t('keys.service')}</FieldLabel>
            <FieldSelect aria-label={t('keys.service')} value={pick} onChange={(e) => setPick(e.target.value)}>
              {data.adapters.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.displayName}
                </option>
              ))}
            </FieldSelect>
            {chosen?.note && !needsName && <Note>{chosen.note}</Note>}
            {chosen?.limitsNote && <Note>{chosen.limitsNote}</Note>}
          </div>
          {needsName && (
            <>
              <div>
                <FieldLabel>{t('lend.name')}</FieldLabel>
                <FieldInput aria-label={t('modelBridge.serviceName')} placeholder={t('modelBridge.myService')} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div>
                <FieldLabel>{t('tunnel.address')}</FieldLabel>
                <FieldInput
                  aria-label={t('keys.serviceAddress')}
                  className="font-mono"
                  placeholder={EXAMPLE_URL}
                  autoComplete="off"
                  spellCheck={false}
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                />
              </div>
            </>
          )}
          <div>
            <FieldLabel>{t('keys.keyWord')}</FieldLabel>
            <FieldInput
              aria-label={t('keys.serviceKey')}
              type="password"
              className="font-mono"
              placeholder={t('keys.paste')}
              autoComplete="off"
              spellCheck={false}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            <Note>{t('modelBridge.keptIn', { store: data.storageLabel })}</Note>
          </div>
          <div className="st-mb-actions">
            <Btn primary disabled={!canSave} onClick={() => void saveKey()}>
              {t('modelBridge.saveKey')}
            </Btn>
            <Btn disabled={busy} onClick={closeConnect}>
              {t('lend.cancel')}
            </Btn>
          </div>
        </div>
      )}

      {status && <Note role="status">{status}</Note>}
      {error && <Note role="alert">{error}</Note>}
      {data.problems.map((p) => (
        <Note key={p}>{p}</Note>
      ))}
    </SettingBlock>
  );
}

export const modelBridgeRows: RowDef[] = [
  {
    id: 'model-bridge',
    label: 'Another model in Codex',
    hint: 'Connect a model service with a key, then add it to Codex. A backup is kept.',
    keywords: 'orchestrator model bridge service key codex provider connect responses api credential backup undo',
    group: 'Model Bridge',
    labsFlag: 'model_bridge_enabled',
    render: () => <ModelBridge />,
  },
];
