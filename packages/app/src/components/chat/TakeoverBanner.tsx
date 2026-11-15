// "An agent took <helper> for a task": shown in the chat the person was using a standby in. Their turn was stopped and their
// message is back in the box (SessionChatPanel does that); the box is locked until the task is over. One button stops the
// task and gives the helper back.
import { useState } from 'react';
import { useT } from '../../i18n';
import { errorSentence } from '../../lib/sayError';
import { tauriStandbyHelpersApi, useStandbyHelpers, type StandbyHelperEntry, type StandbyHelpersApi } from '../../lib/standbyHelpers';
import '../../styles/standby-rows.css';

/** The standby an agent took over from the person in chat `paneId`, or null. */
export function useTakenOver(paneId: string, api: StandbyHelpersApi = tauriStandbyHelpersApi): { helper: StandbyHelperEntry | null; api: StandbyHelpersApi; apply: ReturnType<typeof useStandbyHelpers>['apply'] } {
  const { view, apply } = useStandbyHelpers(api);
  const helper = view.helpers.find((h) => h.taken_over && h.person_pane === paneId) ?? null;
  return { helper, api, apply };
}

export function TakeoverBanner({ helper, api, apply }: { helper: StandbyHelperEntry; api: StandbyHelpersApi; apply: ReturnType<typeof useStandbyHelpers>['apply'] }) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="takeover-banner" role="status" data-testid="takeover-banner">
      <span>
        <b>{t('standby.tookAnon', { name: helper.name })}</b> {t('standby.tookBody', { name: helper.name })}
      </span>
      <button
        type="button"
        className="ck-btn ck-btn--secondary"
        data-testid="takeover-take-back"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          api
            .takeBack(helper.id)
            .then(apply)
            .catch((e) => setError(errorSentence(e)))
            .finally(() => setBusy(false));
        }}
      >
        {t('standby.takeBack')}
      </button>
      {error && <span role="alert">{error}</span>}
    </div>
  );
}
