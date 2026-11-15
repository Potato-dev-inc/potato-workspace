// "New standby helper": a small sheet that makes a standby (agent, model, project, name). Opened from the helpers bar's
// "+ Standby", the New agent menu, and the What's new tour's "Try it" (`standby.new`). Mounted once in the cockpit.
import { useCallback, useEffect, useState } from 'react';
import { useT } from '../../i18n';
import { NEW_STANDBY_EVENT, tauriStandbyHelpersApi, useStandbyHelpers, type StandbyHelpersApi } from '../../lib/standbyHelpers';
import { errorSentence } from '../../lib/sayError';
import { registerAction } from '../../whatsnew/registry';
import { NewStandbyForm } from '../settings/blocks/StandbyHelpersSettings';

export function StandbyNewDialog({ api = tauriStandbyHelpersApi, fallbackProject }: { api?: StandbyHelpersApi; fallbackProject?: string | null }) {
  const t = useT();
  const { view, apply } = useStandbyHelpers(api);
  const [open, setOpen] = useState(false);
  const [project, setProject] = useState('');
  const [error, setError] = useState<string | null>(null);

  const show = useCallback(
    (folder?: string | null) => {
      setProject(folder || fallbackProject || '');
      setError(null);
      setOpen(true);
    },
    [fallbackProject],
  );
  useEffect(() => {
    const onEvent = (event: Event) => show((event as CustomEvent<{ project?: string | null }>).detail?.project);
    window.addEventListener(NEW_STANDBY_EVENT, onEvent);
    const off = registerAction('standby.new', () => {
      show();
      return true;
    });
    return () => {
      window.removeEventListener(NEW_STANDBY_EVENT, onEvent);
      off();
    };
  }, [show]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;
  const atLimit = view.helpers.length >= view.max;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-24" data-testid="standby-dialog" onPointerDown={() => setOpen(false)}>
      <div role="dialog" aria-label={t('standby.newTitle')} className="w-[340px] max-w-[92vw] rounded-xl border border-pm-border bg-pm-panel p-4 shadow-xl" onPointerDown={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold">{t('standby.newTitle')}</h3>
        <p className="mb-3 mt-1 text-xs text-pm-muted">{atLimit ? t('standby.atLimit', { count: view.helpers.length }) : t('standby.dialogHelp')}</p>
        {error && (
          <p role="alert" className="mb-2 text-xs text-pm-text">
            {error}
          </p>
        )}
        <NewStandbyForm
          api={api}
          disabled={atLimit}
          defaultProject={project}
          onCancel={() => setOpen(false)}
          onDone={async (change) => {
            try {
              apply(await change());
              setOpen(false);
            } catch (e) {
              setError(errorSentence(e));
            }
          }}
        />
      </div>
    </div>
  );
}
