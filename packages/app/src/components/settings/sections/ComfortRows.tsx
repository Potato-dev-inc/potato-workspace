// Settings > Look and feel > Comfort: text size, strong contrast, less motion, say results out loud.
// The prefs live in lib/comfort (this computer only); each row changes them at once and the page follows.
import { useT, type MessageKey } from '../../../i18n';
import { TEXT_SCALES, clampTextScale } from '../../../lib/comfort/model';
import { useComfort } from '../../../lib/comfort/store';
import type { RowDef } from '../model';
import { FieldSelect, SettingRow, SettingToggle } from '../settings-ui';

function TextSizeRow() {
  const t = useT();
  const [prefs, update] = useComfort();
  return (
    <SettingRow label={t('lookFeel.comfort.textSize.label')} description={t('lookFeel.comfort.textSize.hint')}>
      <FieldSelect
        aria-label={t('lookFeel.comfort.textSize.label')}
        value={prefs.textScale}
        onChange={(e) => update({ textScale: clampTextScale(e.target.value) })}
      >
        {TEXT_SCALES.map((scale) => (
          <option key={scale} value={scale}>
            {scale}%
          </option>
        ))}
      </FieldSelect>
    </SettingRow>
  );
}

function ComfortToggle({ field, label, hint }: { field: 'strongContrast' | 'lessMotion' | 'speakResults'; label: MessageKey; hint: MessageKey }) {
  const t = useT();
  const [prefs, update] = useComfort();
  return (
    <SettingToggle
      label={t(label)}
      description={t(hint)}
      checked={prefs[field]}
      onChange={(value) => update({ [field]: value })}
    />
  );
}

export const comfortRows: RowDef[] = [
  {
    id: 'text-size',
    label: 'Text size',
    hint: 'Makes everything bigger or smaller. Ctrl + and Ctrl - change it too.',
    keywords: 'text size font zoom bigger smaller large small scale accessibility eyes 4k ctrl',
    group: 'Comfort',
    render: () => <TextSizeRow />,
  },
  {
    id: 'strong-contrast',
    label: 'Strong contrast',
    hint: 'Brighter text and firmer lines, in light and dark.',
    keywords: 'contrast strong bright dark light readable visibility low vision accessibility',
    group: 'Comfort',
    render: () => <ComfortToggle field="strongContrast" label="lookFeel.comfort.contrast.label" hint="lookFeel.comfort.contrast.hint" />,
  },
  {
    id: 'less-motion',
    label: 'Less motion',
    hint: 'Stops animations and spinners. Also on when Windows asks for less motion.',
    keywords: 'motion animation reduce spinner still calm reduced transitions vestibular',
    group: 'Comfort',
    render: () => <ComfortToggle field="lessMotion" label="lookFeel.comfort.motion.label" hint="lookFeel.comfort.motion.hint" />,
  },
  {
    id: 'speak-results',
    label: 'Say results out loud',
    hint: 'When an agent finishes, the Windows voice says so. Nothing leaves this computer.',
    keywords: 'speak voice say read aloud speech tts audio sound finished done results announce',
    group: 'Comfort',
    render: () => <ComfortToggle field="speakResults" label="lookFeel.comfort.speak.label" hint="lookFeel.comfort.speak.hint" />,
  },
];
