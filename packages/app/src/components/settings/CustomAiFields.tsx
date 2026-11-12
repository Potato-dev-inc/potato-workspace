// The three fields of a "Custom AI service": where it lives (a preset or any address), the key, and the model.
// Presentational and controlled, so the agent wizard uses it today and a general custom provider can use it
// later. The key is typed here and saved by the caller into the credential store; it is never shown again,
// only "Saved, ends in 1234".
import { CUSTOM_AI_PRESETS, normalizeBaseUrl, presetById, type CustomAiPresetId, type CustomAiService } from '../../lib/custom-ai';

const FIELD = 'mt-1 block w-full rounded-lg border border-pm-border bg-transparent px-2 py-1 text-xs';

export function CustomAiFields({
  value,
  onChange,
  keyDraft,
  onKeyDraft,
  keySet,
  last4,
  testId = 'custom-ai-fields',
}: {
  value: CustomAiService;
  onChange: (next: CustomAiService) => void;
  /** What is typed in the key box. Empty keeps the saved key. */
  keyDraft: string;
  onKeyDraft: (text: string) => void;
  /** A key is already saved in the credential store. */
  keySet: boolean;
  last4?: string | null;
  testId?: string;
}) {
  const preset = presetById(value.preset);

  const pickPreset = (id: CustomAiPresetId) => {
    const next = presetById(id);
    if (!next) return;
    // "Other service" keeps what was typed; a named service brings its own address and a starting model.
    onChange(
      id === 'other'
        ? { ...value, preset: id }
        : { preset: id, baseUrl: next.baseUrl, model: value.preset === id ? value.model : next.model },
    );
  };

  const typeAddress = (text: string) => {
    const base = normalizeBaseUrl(text);
    const match = CUSTOM_AI_PRESETS.find((p) => p.baseUrl !== '' && p.baseUrl === base);
    onChange({ ...value, baseUrl: text, preset: match ? match.id : 'other' });
  };

  return (
    <div className="space-y-2" data-testid={testId}>
      <label className="block text-xs text-pm-muted">
        Service
        <select
          aria-label="AI service"
          className={FIELD}
          value={preset ? preset.id : 'other'}
          onChange={(e) => pickPreset(e.target.value as CustomAiPresetId)}
        >
          {CUSTOM_AI_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      {preset && <p className="text-xs text-pm-muted">{preset.hint}</p>}
      <label className="block text-xs text-pm-muted">
        Address
        <input
          aria-label="Service address"
          className={`${FIELD} font-mono`}
          placeholder="https://api.example.com/v1"
          autoComplete="off"
          spellCheck={false}
          value={value.baseUrl}
          onChange={(e) => typeAddress(e.target.value)}
        />
      </label>
      <label className="block text-xs text-pm-muted">
        Key
        <input
          aria-label="Service key"
          type="password"
          className={`${FIELD} font-mono`}
          placeholder={keySet ? `Saved${last4 ? `, ends in ${last4}` : ''}. Type to replace it.` : 'Paste your key'}
          autoComplete="off"
          spellCheck={false}
          value={keyDraft}
          onChange={(e) => onKeyDraft(e.target.value)}
        />
      </label>
      <label className="block text-xs text-pm-muted">
        Model
        <input
          aria-label="Model name"
          className={`${FIELD} font-mono`}
          placeholder="model-name or vendor/model"
          autoComplete="off"
          spellCheck={false}
          value={value.model}
          onChange={(e) => onChange({ ...value, model: e.target.value })}
        />
      </label>
    </div>
  );
}
