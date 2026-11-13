// Settings > General: "Start Potato Workspace when I sign in" (OS entry, off by default). Saves itself.
import { useT } from '../../../i18n';
import { useStartAtSignIn } from '../../../hooks/useStartAtSignIn';
import { Note, SettingToggle } from '../settings-ui';

export const START_AT_SIGN_IN_LABEL = 'Start Potato Workspace when I sign in';
export const START_AT_SIGN_IN_HINT = 'It starts quietly in the tray. Your companion wakes up too.';

export function StartAtSignInSettings({ onSaved }: { onSaved?: () => void }) {
  const t = useT();
  const start = useStartAtSignIn();
  return (
    <>
      <SettingToggle
        label={t('lookFeel.startAtSignIn.label')}
        description={t('lookFeel.startAtSignIn.hint')}
        checked={start.enabled}
        disabled={!start.ready}
        onChange={(value) => {
          void start.change(value).then((ok) => {
            if (ok) onSaved?.();
          });
        }}
      />
      {start.error && <Note role="alert">{start.error}</Note>}
    </>
  );
}
