// The Labs page (Advanced > Early features): every early feature in one place, grouped by area, with a search box.
// A plain on/off feature gets its switch here. It saves through the same `patch` as its own row. The rest get an
// Open button that jumps to their row. In a development build every switch reads as on (`lib/dev-labs.ts`).
import { useState } from 'react';
import type { SettingsPatch } from '../../lib/settings';
import { t, type MessageKey } from '../../i18n';
import { DEV_LABS_NOTE, useDevLabsOverride } from '../../lib/dev-labs';
import type { RowDef, SettingsEnv } from './model';
import { LABS_AREAS, LABS_SWITCH_KEYS, labsAreaOf, type LabsArea } from './labs-areas';
import { LabsSwitch } from './LabsSwitch';
import { Note, SettingBlock } from './settings-ui';

const AREA_TITLE: Record<LabsArea, MessageKey> = {
  Chat: 'labsPage.area.chat',
  Helpers: 'labsPage.area.helpers',
  Devices: 'labsPage.area.devices',
  Team: 'labsPage.area.team',
  Phone: 'labsPage.area.phone',
  Other: 'labsPage.area.other',
};

/** A translated piece of a Labs row, or the English from the row when there is no translation. */
function labsText(key: string, english: string): string {
  const text = t(key as MessageKey);
  return text === key ? english : text;
}

interface Item {
  row: RowDef;
  name: string;
  line: string;
  area: LabsArea;
}

export function LabsPage({ env, labs }: { env: SettingsEnv; labs: RowDef[] }) {
  const devLabs = useDevLabsOverride();
  const [query, setQuery] = useState('');
  // Each area is a card that starts closed. A search opens every area that has a match.
  const [openAreas, setOpenAreas] = useState<ReadonlySet<LabsArea>>(new Set());
  const items: Item[] = labs.map((row) => ({
    row,
    name: labsText(`labs.${row.id}.name`, row.labs?.name ?? row.label),
    line: labsText(`labsPage.line.${row.id}`, row.labs?.about ?? ''),
    area: labsAreaOf(row.id),
  }));
  const needle = query.trim().toLowerCase();
  const shown = needle ? items.filter((item) => `${item.name} ${item.line} ${item.row.keywords ?? ''}`.toLowerCase().includes(needle)) : items;

  return (
    <SettingBlock label={t('settings.row.labs-index.label')} description={t('settings.row.labs-index.hint')}>
      {devLabs && <Note>{DEV_LABS_NOTE}</Note>}
      <label className="st-search st-labs-search">
        <input type="search" aria-label={t('labsPage.search')} placeholder={t('labsPage.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      {shown.length === 0 && <p className="st-labs-empty">{t('labsPage.empty', { query: query.trim() })}</p>}
      {LABS_AREAS.map((area) => {
        const group = shown.filter((item) => item.area === area);
        if (group.length === 0) return null;
        const open = needle !== '' || openAreas.has(area);
        const toggle = () =>
          setOpenAreas((cur) => {
            const next = new Set(cur);
            if (next.has(area)) next.delete(area);
            else next.add(area);
            return next;
          });
        return (
          <section key={area} className="st-labs-area st-closed-group" data-area={area} data-open={open ? 'true' : 'false'}>
            <div className="st-list">
              <button type="button" className="st-adv-toggle" aria-expanded={open} onClick={toggle}>
                <span aria-hidden="true">{open ? '⌄' : '›'}</span>
                <span>{t(AREA_TITLE[area])}</span>
                <span className="st-adv-count">{group.length}</span>
              </button>
              {open && (
                <ul className="st-labs-list">
                  {group.map((item) => {
                    const key = LABS_SWITCH_KEYS[item.row.id];
                    return (
                      <li key={item.row.id} className="st-labs-feature">
                        {key ? (
                          <LabsSwitch
                            label={item.name}
                            description={item.line}
                            checked={env.settings[key] === true}
                            onChange={(value) => void env.patch({ [key]: value } as SettingsPatch)}
                          />
                        ) : (
                          <button type="button" className="st-labs-item" aria-label={t('labsPage.openNamed', { name: item.name })} onClick={() => env.openRow?.(item.row.id)}>
                            <span className="st-labs-name">{item.name}</span>
                            <span className="st-labs-about">{item.line}</span>
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </section>
        );
      })}
    </SettingBlock>
  );
}
