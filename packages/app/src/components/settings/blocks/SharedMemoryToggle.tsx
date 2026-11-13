// Settings > General: the app-wide "Shared project memory" switch (see components/cockpit/ProjectMemory.tsx).
import { useEffect, useState } from 'react';
import { useT } from '../../../i18n';
import { memoryApi } from '../../../lib/memory-api';
import { SettingToggle } from '../settings-ui';

export function SharedMemoryToggle({ onSaved }: { onSaved?: () => void }) {
  const t = useT();
  const [on, setOn] = useState(true);
  useEffect(() => {
    void memoryApi.globalEnabled().then(setOn).catch(() => undefined);
  }, []);
  return (
    <SettingToggle
      label={t('settings.row.shared-memory.label')}
      description={t('memory.help')}
      checked={on}
      onChange={(value) => {
        setOn(value);
        void memoryApi
          .setGlobalEnabled(value)
          .then(() => onSaved?.())
          .catch(() => setOn(!value));
      }}
    />
  );
}
