// Three steps after a phone is paired: add it to the Home Screen (with iPhone or Android help), allow notifications, and see a test
// notification. Nothing here is required: "Done" closes it, and Settings > Help opens it again.
import { useEffect, useMemo, useState } from 'react';
import { useT } from '../../i18n';
import { browserDeps, enable, initialState, readEnv, type PushDeps, type PushEnv, type ToggleState } from '../../lib/push-client';
import { platformOf, sendLocalTestNotification, type TestResult } from '../../lib/phone-setup';
import { Sheet } from './MobileSheet';
import '../../styles/phone-link.css';

export function PhoneSetupSteps({
  baseUrl,
  onDone,
  deps: injected,
  env: injectedEnv,
  platform: injectedPlatform,
  sendTest = sendLocalTestNotification,
}: {
  baseUrl: string;
  onDone: () => void;
  /** Tests inject fakes. */
  deps?: PushDeps;
  env?: PushEnv;
  platform?: ReturnType<typeof platformOf>;
  sendTest?: typeof sendLocalTestNotification;
}) {
  const t = useT();
  const deps = useMemo(() => injected ?? browserDeps(baseUrl), [injected, baseUrl]);
  const env = useMemo(() => injectedEnv ?? readEnv(), [injectedEnv]);
  const platform = injectedPlatform ?? platformOf(typeof navigator === 'undefined' ? '' : navigator.userAgent, typeof navigator === 'undefined' ? 0 : navigator.maxTouchPoints);
  const [push, setPush] = useState<ToggleState>({ kind: 'working' });
  const [test, setTest] = useState<TestResult | null>(null);

  useEffect(() => {
    let live = true;
    const permission = typeof Notification === 'undefined' ? 'default' : deps.permission();
    const early = initialState(env, permission, false);
    if (early.kind !== 'off') {
      setPush(early);
      return;
    }
    void deps
      .isSubscribed()
      .catch(() => false)
      .then((subscribed) => live && setPush(initialState(env, permission, subscribed)));
    return () => {
      live = false;
    };
  }, [deps, env]);

  const homeDone = env.isStandalone;
  const pushOn = push.kind === 'on';
  const pushNote =
    push.kind === 'ios-install' ? t('phone.setup.pushNeedsHome')
    : push.kind === 'unsupported' ? t('phone.setup.pushUnsupported')
    : push.kind === 'blocked' ? t('phone.setup.pushBlocked')
    : push.kind === 'error' ? push.message
    : null;
  const testNote =
    test === 'sent' ? t('phone.setup.testSent')
    : test === 'no-permission' ? t('phone.setup.testNoPermission')
    : test === 'unsupported' ? t('phone.setup.pushUnsupported')
    : test === 'failed' ? t('phone.setup.testFailed')
    : null;

  return (
    <Sheet title={t('phone.setup.title')} onClose={onDone}>
      <ol className="ph-steps" data-testid="phone-setup">
        <li data-done={homeDone || undefined}>
          <h3>{t('phone.setup.homeTitle')}</h3>
          <p>{homeDone ? t('phone.setup.homeDone') : platform === 'ios' ? t('phone.setup.homeIos') : platform === 'android' ? t('phone.setup.homeAndroid') : t('phone.setup.homeOther')}</p>
        </li>
        <li data-done={pushOn || undefined}>
          <h3>{t('phone.setup.pushTitle')}</h3>
          <p>{pushOn ? t('phone.setup.pushOn') : t('phone.setup.pushBody')}</p>
          {!pushOn && push.kind !== 'working' && (
            <button
              type="button"
              className="ph-step-btn"
              disabled={push.kind === 'ios-install' || push.kind === 'unsupported' || push.kind === 'blocked'}
              onClick={() => {
                // No await before enable(): the permission prompt needs the tap.
                const pending = enable(deps);
                setPush({ kind: 'working' });
                void pending.then(setPush);
              }}
            >
              {t('phone.setup.pushButton')}
            </button>
          )}
          {pushNote && (
            <p className="ph-step-note" role="status">
              {pushNote}
            </p>
          )}
        </li>
        <li data-done={test === 'sent' || undefined}>
          <h3>{t('phone.setup.testTitle')}</h3>
          <p>{t('phone.setup.testBody')}</p>
          <button type="button" className="ph-step-btn" onClick={() => void sendTest(t('phone.setup.testNotifTitle'), t('phone.setup.testNotifBody')).then(setTest)}>
            {t('phone.setup.testButton')}
          </button>
          {testNote && (
            <p className="ph-step-note" role="status">
              {testNote}
            </p>
          )}
        </li>
      </ol>
      <button type="button" className="ph-step-done" onClick={onDone}>
        {t('phone.setup.done')}
      </button>
    </Sheet>
  );
}
