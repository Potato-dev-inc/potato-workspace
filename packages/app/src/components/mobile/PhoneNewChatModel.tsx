// The model pill on the phone's New chat box: the same "Sonnet 5.5 ▾" pill a running chat has, fed by the PC's model list for
// the picked agent (the one the desktop's New agent page shows). Loading shows "Loading models…"; no list (an older PC, or an
// agent that never reports one) shows no pill at all. The pick is applied to the new chat right after it starts.
import { useEffect, useState } from 'react';
import { useT } from '../../i18n';
import type { BridgeClient } from '../../lib/bridge-types';
import { optionsFromWire, type ModelOptions } from '../../lib/modelOptions';
import { Sheet } from './MobileSheet';
import { friendlyName } from './PhonePicker';
import '../../styles/phone-pick.css';

export type PhoneModelList = { status: 'loading' } | { status: 'ready'; options: ModelOptions; optionId: string } | { status: 'none' };

/** The model list for one agent from the PC. `none` when the PC has no such route or the agent has no list. */
export function usePhoneModelList(bridge: BridgeClient | null, agentId: string | null): PhoneModelList {
  const [state, setState] = useState<{ agent: string | null; value: PhoneModelList }>({ agent: null, value: { status: 'loading' } });
  useEffect(() => {
    if (!agentId) return;
    if (!bridge?.phoneModelOptions) {
      setState({ agent: agentId, value: { status: 'none' } });
      return;
    }
    let live = true;
    setState({ agent: agentId, value: { status: 'loading' } });
    bridge.phoneModelOptions(agentId).then(
      (wire) => {
        if (!live) return;
        const body = wire as { live?: { id?: unknown } } | null;
        const options = optionsFromWire(wire as Parameters<typeof optionsFromWire>[0]);
        const optionId = typeof body?.live?.id === 'string' ? body.live.id : 'model';
        const any = (options.live?.length ?? 0) > 0 || options.models.length > 0;
        setState({ agent: agentId, value: any ? { status: 'ready', options, optionId } : { status: 'none' } });
      },
      () => live && setState({ agent: agentId, value: { status: 'none' } }),
    );
    return () => {
      live = false;
    };
  }, [bridge, agentId]);
  return state.agent === agentId ? state.value : { status: 'loading' };
}

/** What the sheet lists: the agent's own list with names, else its plain ids. */
export function choicesOf(options: ModelOptions): Array<{ value: string; name: string; description: string | null }> {
  if (options.live && options.live.length > 0) return options.live.map((m) => ({ value: m.value, name: friendlyName(m.name, m.value), description: m.description }));
  return options.models.map((m) => ({ value: m, name: friendlyName(m, m), description: null }));
}

export function PhoneNewChatModel({ list, picked, onPick }: { list: PhoneModelList; picked: string | null; onPick: (value: string | null) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (list.status === 'none') return null;
  if (list.status === 'loading') {
    return (
      <span className="ph-comp-model ph-pick-pill" data-testid="nc-model-loading" role="status">
        <span>{t('phone.nc.modelLoading')}</span>
      </span>
    );
  }
  const choices = choicesOf(list.options);
  const current = choices.find((c) => c.value === picked);
  const def = list.options.defaultModel;
  const defaultName = def ? (choices.find((c) => c.value === def)?.name ?? friendlyName(def, def)) : t('phone.nc.modelDefault');
  const label = current ? current.name : defaultName;
  const rows: Array<{ value: string | null; name: string; description: string | null }> = [{ value: null, name: t('phone.nc.modelDefaultOpt', { name: defaultName }), description: null }, ...choices];
  return (
    <>
      <button type="button" className="ph-comp-model ph-pick-pill" data-testid="nc-model-pill" aria-haspopup="dialog" aria-label={`${t('phone.nc.modelOpen')}: ${label}`} onClick={() => setOpen(true)}>
        <span>{label}</span>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m7 10 5 5 5-5" />
        </svg>
      </button>
      {open && (
        <Sheet title={t('phone.nc.modelTitle')} onClose={() => setOpen(false)}>
          <div className="ph-pick" data-testid="nc-model-sheet">
            <div role="radiogroup" aria-label={t('phone.nc.modelTitle')}>
              {rows.map((choice) => {
                const on = choice.value === (current ? current.value : null);
                return (
                  <button
                    key={choice.value ?? 'default'}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    className="ph-pick-opt"
                    data-on={on || undefined}
                    onClick={() => {
                      onPick(choice.value);
                      setOpen(false);
                    }}
                  >
                    <span className="ph-pick-txt">
                      <span className="ph-pick-name">{choice.name}</span>
                      {choice.description && <span className="ph-pick-desc">{choice.description}</span>}
                    </span>
                    {on && (
                      <svg className="ph-pick-tick" viewBox="0 0 24 24" aria-hidden="true">
                        <path d="m5 12.5 4.5 4.5L19 7.5" />
                      </svg>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </Sheet>
      )}
    </>
  );
}
