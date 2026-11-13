// Settings > Orchestrator & Models: the project index builder and the OpenCode defaults. Every control autosaves.
import { t } from '../../../i18n';
import { TextControl } from '../controls';
import type { RowDef } from '../model';
import { SettingRow } from '../settings-ui';

/** Example values in the empty fields: ids and a word that is code, the same in every language. */
const EXAMPLE = { indexer: 'opencode', provider: 'anthropic', model: 'claude-sonnet-4' };

const trim = (text: string) => text.trim();

export const modelsRows: RowDef[] = [
  {
    id: 'librarian-indexer',
    label: 'Project index',
    hint: 'Empty: OpenCode builds it. Or the path to your own script.',
    keywords: 'orchestrator project index builder librarian indexer path script static project-indexer.py opencode',
    group: 'Project index',
    render: (env) => (
      <SettingRow
        label={t('settings.row.librarian-indexer.label')}
        description={t('settings.row.librarian-indexer.hint')}
      >
        <TextControl
          aria-label={t('settings.row.librarian-indexer.label')}
          mode="blur"
          mono
          placeholder={EXAMPLE.indexer}
          value={env.settings.librarian_indexer_path ?? ''}
          normalize={trim}
          onCommit={(text) => env.patch({ librarian_indexer_path: text || null })}
        />
      </SettingRow>
    ),
  },
  {
    id: 'opencode-provider',
    label: 'OpenCode: model service',
    hint: 'Used when you start OpenCode without naming a model.',
    keywords: 'orchestrator opencode provider id anthropic model',
    group: 'OpenCode',
    render: (env) => (
      <SettingRow label={t('settings.row.opencode-provider.label')} description={t('settings.row.opencode-provider.hint')}>
        <TextControl
          aria-label={t('models.providerId')}
          mode="blur"
          mono
          placeholder={EXAMPLE.provider}
          value={env.settings.opencode_model_provider ?? ''}
          normalize={trim}
          onCommit={(text) => env.patch({ opencode_model_provider: text || null })}
        />
      </SettingRow>
    ),
  },
  {
    id: 'opencode-model',
    label: 'OpenCode: model',
    hint: 'The model used with the service above.',
    keywords: 'orchestrator opencode model id',
    group: 'OpenCode',
    render: (env) => (
      <SettingRow label={t('settings.row.opencode-model.label')} description={t('settings.row.opencode-model.hint')}>
        <TextControl
          aria-label={t('models.modelId')}
          mode="blur"
          mono
          placeholder={EXAMPLE.model}
          value={env.settings.opencode_model_id ?? ''}
          normalize={trim}
          onCommit={(text) => env.patch({ opencode_model_id: text || null })}
        />
      </SettingRow>
    ),
  },
];
