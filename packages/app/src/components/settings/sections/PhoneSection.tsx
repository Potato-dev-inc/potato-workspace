// The phone rows that Connect > Phone draws (phone alerts, keyboard and typing box, revoke all, Telegram). Settings no longer
// has a Phone page: ConnectPage reads these rows with `phoneRowsOriginal` and shows them through RowShell.
import { errorSentence } from '../../../lib/sayError';
import { t, useT } from '../../../i18n';
import { useEffect, useState } from 'react';
import { tauri } from '../../../lib/tauri';
import { DEVICES_CHANGED_EVENT } from '../../MobilePairingPanel';
import type { RowDef, SettingsEnv } from '../model';
import { SendTest, type TestResult } from '../previews/Previews';
import { Btn, SettingRow, SettingToggle } from '../settings-ui';
import { TelegramSetup } from '../blocks/TelegramSetup';

type PairedDevice = Awaited<ReturnType<typeof tauri.listPairedMobileDevices>>[number];

// ---------- revoke all devices ----------

function RevokeAllRow({ env }: { env: SettingsEnv }) {
  const t = useT();
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void tauri.listPairedMobileDevices().then(setDevices).catch(() => undefined);
  }, []);

  const revokeAll = async () => {
    env.setError(null);
    const ok = await env.confirm({
      title: t('phone.revokeAll.title'),
      body: t('phone.revokeAll.body'),
      confirmLabel: t('phone.revokeAll.confirm'),
    });
    if (!ok) return;
    setBusy(true);
    try {
      const paired = await tauri.listPairedMobileDevices();
      for (const device of paired) await tauri.revokePairedMobileDevice(device.id);
      window.dispatchEvent(new Event(DEVICES_CHANGED_EVENT));
      env.markSaved();
    } catch (error) {
      env.setError(t('phone.revokeAll.failed', { reason: errorSentence(error) }));
    } finally {
      setBusy(false);
      setDevices(await tauri.listPairedMobileDevices());
    }
  };

  return (
    <SettingRow label={t('settings.row.revoke-all-devices.label')} description={t('settings.row.revoke-all-devices.hint')}>
      <Btn disabled={busy || devices.length === 0} onClick={() => void revokeAll()}>
        {busy ? t('phone.revokeAll.busy') : t('phone.revokeAll.button')}
      </Btn>
    </SettingRow>
  );
}

// ---------- phone alerts ----------

/**
 * Where the phone's alerts are turned on (in the phone app), and "Send a test". The test needs a paired phone and a
 * sender: this build has no command that pushes a test alert, so with phones paired the button is not drawn (a button
 * that could only fail would be worse than none). With no phone it says why a test cannot be sent.
 */
function PhoneAlerts({ sendTest }: { sendTest?: () => Promise<TestResult> }) {
  const t = useT();
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    void tauri.listPairedMobileDevices().then((list) => setCount(list.length)).catch(() => setCount(null));
  }, []);
  return (
    <SettingRow label={t('settings.row.phone-notifications.label')} description={t('settings.row.phone-notifications.hint')}>
      <span className="st-value">{t('phone.alerts.onPhone')}</span>
      {count === 0 && <SendTest disabledReason={t('phone.alerts.pairFirst')} />}
      {count !== null && count > 0 && sendTest && <SendTest send={sendTest} />}
    </SettingRow>
  );
}

// ---------- the rows ----------

const NOTIFICATIONS =
  'Turn on in the phone app. Lock-screen previews can show commands; turn them off if needed.';

export const phoneRowsOriginal: RowDef[] = [
  {
    id: 'phone-notifications',
    label: 'Phone alerts',
    hint: NOTIFICATIONS,
    keywords: 'alerts push lock screen previews needs you',
    group: 'Phone app',
    render: () => <PhoneAlerts />,
  },
  {
    id: 'mobile-keyboard-resizes',
    label: 'Keyboard resizes the agent',
    hint: 'Off: the keyboard covers the top of the agent. On: the agent redraws above it.',
    keywords: 'keyboard resize redraw phone screen',
    group: 'Phone app',
    render: (env) => (
      <SettingToggle
        label={t('settings.row.mobile-keyboard-resizes.label')}
        description={t('settings.row.mobile-keyboard-resizes.hint')}
        checked={env.settings.mobile_keyboard_resizes_agent ?? false}
        onChange={(value) => void env.patch({ mobile_keyboard_resizes_agent: value })}
      />
    ),
  },
  {
    id: 'mobile-input-visible',
    label: 'Show the typing box on the phone',
    hint: 'When off, the box under the terminal is hidden, but the terminal still takes your taps.',
    keywords: 'input box tap target mobile phone keyboard',
    group: 'Phone app',
    render: (env) => (
      <SettingToggle
        label={t('settings.row.mobile-input-visible.label')}
        description={t('settings.row.mobile-input-visible.hint')}
        checked={env.settings.mobile_input_visible ?? true}
        onChange={(value) => void env.patch({ mobile_input_visible: value })}
      />
    ),
  },
  {
    id: 'revoke-all-devices',
    label: 'Revoke all devices',
    hint: 'Every paired phone is signed out and must pair again.',
    keywords: 'revoke sign out phones devices unpair',
    group: 'Devices',
    danger: true,
    render: (env) => <RevokeAllRow env={env} />,
  },
  {
    id: 'telegram',
    label: 'Telegram',
    hint: 'Answer your agents by Telegram text. Read the warning first.',
    keywords: 'telegram bot text message chat token pairing remote early answer',
    group: 'Telegram',
    labs: { name: 'Telegram', about: 'Ask your agents and answer them by Telegram text, through a third party.' },
    render: (env) => <TelegramSetup env={env} />,
  },
];
