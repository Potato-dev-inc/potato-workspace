// Settings > Orchestrator & Models: the project index builder and the OpenCode defaults. Every control autosaves.
import { TextControl } from '../controls';
import type { RowDef } from '../model';
import { SettingRow } from '../settings-ui';

const trim = (text: string) => text.trim();

export const modelsRows: RowDef[] = [
  {
    id: 'librarian-indexer',
    label: 'Project index builder',
    hint: 'Blank: OpenCode builds the index. Or the path to a script that builds one without AI.',
    keywords: 'librarian indexer path script static project-indexer.py opencode',
    group: 'Project index',
    render: (env) => (
      <SettingRow
        label="Project index builder"
        description="Leave blank to let OpenCode build the project index. Or give the path to a script that builds a simple index without AI."
      >
        <TextControl
          aria-label="Project index builder"
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
    label: 'OpenCode provider',
    hint: 'Used when a prompt to an OpenCode agent does not name a model.',
    keywords: 'opencode provider id anthropic model',
    group: 'OpenCode',
    render: (env) => (
      <SettingRow label="OpenCode provider" description="Used when a prompt to an OpenCode agent does not name a model.">
        <TextControl
          aria-label="OpenCode provider ID"
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
    label: 'OpenCode model',
    hint: 'The model used with the provider above.',
    keywords: 'opencode model id',
    group: 'OpenCode',
    render: (env) => (
      <SettingRow label="OpenCode model" description="The model used with the provider above. Also applies to OpenCode chats.">
        <TextControl
          aria-label="OpenCode model ID"
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
