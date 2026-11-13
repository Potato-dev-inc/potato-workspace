// Settings > Orchestrator & Models: the project index builder and the OpenCode defaults. Every control autosaves.
import { TextControl } from '../controls';
import type { RowDef } from '../model';
import { SettingRow } from '../settings-ui';

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
        label="Project index"
        description="Empty: OpenCode builds it. Or the path to your own script."
      >
        <TextControl
          aria-label="Project index"
          mode="blur"
          mono
          placeholder="opencode"
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
      <SettingRow label="OpenCode: model service" description="Used when you start OpenCode without naming a model.">
        <TextControl
          aria-label="OpenCode provider ID"
          mode="blur"
          mono
          placeholder="anthropic"
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
      <SettingRow label="OpenCode: model" description="The model used with the service above.">
        <TextControl
          aria-label="OpenCode model ID"
          mode="blur"
          mono
          placeholder="claude-sonnet-4"
          value={env.settings.opencode_model_id ?? ''}
          normalize={trim}
          onCommit={(text) => env.patch({ opencode_model_id: text || null })}
        />
      </SettingRow>
    ),
  },
];
