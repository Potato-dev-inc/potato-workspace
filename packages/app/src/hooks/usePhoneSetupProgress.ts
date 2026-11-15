// How many of the phone's three setup steps are done, for the one small chip on the home.
// The steps are the same ones `PhoneSetupSteps` draws: Add to Home Screen, allow notifications, send a test.
import { useEffect, useMemo, useState } from 'react';
import { setupDoneCount, testSent } from '../lib/phone-setup';
import { browserDeps, initialState, readEnv } from '../lib/push-client';

/** `revision` changes when the setup steps close, so the chip reads the permission and the test again. */
export function usePhoneSetupProgress(baseUrl: string | null, revision = 0): number {
  const [subscribed, setSubscribed] = useState(false);
  const env = useMemo(() => readEnv(), []);
  const supported = env.hasServiceWorker && env.hasPushManager && env.hasNotification;

  useEffect(() => {
    if (!baseUrl || !supported) return;
    let live = true;
    void browserDeps(baseUrl)
      .isSubscribed()
      .catch(() => false)
      .then((on) => {
        if (live) setSubscribed(on);
      });
    return () => {
      live = false;
    };
  }, [baseUrl, supported, revision]);

  const permission = typeof Notification === 'undefined' ? 'default' : Notification.permission;
  const notifications = initialState(env, permission, subscribed).kind === 'on';
  return setupDoneCount({ home: env.isStandalone, notifications, test: testSent() });
}
