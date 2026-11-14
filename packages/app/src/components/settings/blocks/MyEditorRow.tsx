// Settings > General > My editor: which code editor "Open in editor" uses. The editors installed on this computer are
// found for you; "First one found" follows whatever is installed. The choice stays on this computer.
import { useT } from '../../../i18n';
import { getMyEditor, useMyEditor, type EditorApi } from '../../../lib/my-editor';
import { FieldSelect, Note, SettingRow } from '../settings-ui';

export function MyEditorRow({ onSaved, api }: { onSaved?: () => void; api?: EditorApi }) {
  const t = useT();
  const { editors, choose } = useMyEditor(api);
  const chosen = getMyEditor();
  const value = editors?.some((e) => e.id === chosen) ? (chosen as string) : '';
  return (
    <SettingRow label={t('settings.row.my-editor.label')} description={t('settings.row.my-editor.hint')}>
      {editors !== null && editors.length === 0 ? (
        <Note>{t('editor.row.none')}</Note>
      ) : (
        <FieldSelect
          aria-label={t('settings.row.my-editor.label')}
          value={value}
          disabled={editors === null}
          onChange={(e) => {
            choose(e.target.value || null);
            onSaved?.();
          }}
        >
          <option value="">{t('editor.row.auto')}</option>
          {(editors ?? []).map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </FieldSelect>
      )}
    </SettingRow>
  );
}
