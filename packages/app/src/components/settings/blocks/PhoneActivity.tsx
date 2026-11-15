// Settings > Phone: "Phone and remote activity". One line per thing a paired phone did on this PC (opened, started,
// typed, sent, answered, stopped): a time, the phone's name and a kind, never a prompt or a message. Clear empties
// the list only; the hash-chained security record is not touched.
import { useCallback, useEffect, useState } from 'react';
import { useT } from '../../../i18n';
import { activityLine, sortActivity, type ActivityEntry } from '../../../lib/devices';
import { tauri } from '../../../lib/tauri';
import { DEVICES_CHANGED_EVENT } from '../../MobilePairingPanel';
import { Btn } from '../settings-ui';

/** How often the list reads again while the page is open. */
const REFRESH_MS = 15_000;

export function PhoneActivity() {
  const t = useT();
  const [rows, setRows] = useState<ActivityEntry[]>([]);

  const refresh = useCallback(async () => {
    setRows(sortActivity(await tauri.phoneActivityList()));
  }, []);

  useEffect(() => {
    const read = () => void refresh().catch(() => setRows([]));
    read();
    const timer = window.setInterval(read, REFRESH_MS);
    window.addEventListener(DEVICES_CHANGED_EVENT, read);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(DEVICES_CHANGED_EVENT, read);
    };
  }, [refresh]);

  return (
    <div className="st-row is-block" data-testid="phone-activity">
      <div className="st-label">
        <span>{t('phone.activity.title')}</span>
        <small>{t('phone.activity.hint')}</small>
      </div>
      <div className="st-body">
        {rows.length === 0 ? (
          <p className="st-note" data-testid="phone-activity-none">
            {t('phone.activity.none')}
          </p>
        ) : (
          <>
            <ul className="dev-activity" data-testid="phone-activity-list">
              {rows.map((row, i) => (
                <li key={`${row.at}:${row.node}:${row.kind}:${i}`}>{activityLine(row)}</li>
              ))}
            </ul>
            <div>
              <Btn
                small
                onClick={() => {
                  void tauri.phoneActivityClear().then(() => refresh()).catch(() => undefined);
                }}
              >
                {t('phone.activity.clear')}
              </Btn>
              <small className="st-note"> {t('phone.activity.clearNote')}</small>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
