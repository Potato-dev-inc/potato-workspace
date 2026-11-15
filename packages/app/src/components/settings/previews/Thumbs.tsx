// Small picture choices for a row: two window thumbnails for the theme, a tiny diagram per window layout.
// They are the control (a radio group): the chosen one has a 1 px light ring, and the change applies at once.
import type { ReactNode } from 'react';
import { t } from '../../../i18n';
import type { ThemeChoice } from '../../../lib/theme-tone';

export interface ThumbChoice<T extends string> {
  value: T;
  label: string;
  picture: ReactNode;
}

export function ThumbChoices<T extends string>({
  label,
  value,
  choices,
  onPick,
}: {
  label: string;
  value: T;
  choices: ThumbChoice<T>[];
  onPick: (next: T) => void;
}) {
  return (
    <div className="st-thumbs" role="radiogroup" aria-label={label}>
      {choices.map((choice) => (
        <button
          key={choice.value}
          type="button"
          role="radio"
          aria-checked={choice.value === value}
          aria-label={choice.label}
          data-value={choice.value}
          className="st-thumb"
          onClick={() => {
            if (choice.value !== value) onPick(choice.value);
          }}
        >
          {choice.picture}
          <span>{choice.label}</span>
        </button>
      ))}
    </div>
  );
}

/** The parts of a window in miniature. */
function WindowShapes() {
  return (
    <>
      <rect width="64" height="40" rx="4" className="win" />
      <rect x="0" y="0" width="16" height="40" rx="4" className="side" />
      <rect x="21" y="8" width="26" height="3" rx="1.5" className="line" />
      <rect x="21" y="15" width="38" height="3" rx="1.5" className="faint" />
      <rect x="21" y="22" width="32" height="3" rx="1.5" className="faint" />
      <rect x="4" y="9" width="8" height="3" rx="1.5" className="line" />
      <rect x="4" y="16" width="8" height="3" rx="1.5" className="faint" />
    </>
  );
}

/** A window in miniature, in fixed greys (it shows the theme, so it must not follow the theme). Auto is light on the left, dark on the right. */
function WindowPicture({ tone }: { tone: 'dark' | 'light' | 'dim' | 'auto' }) {
  return (
    <svg className="st-thumb-pic" viewBox="0 0 64 40" aria-hidden="true" data-tone={tone}>
      {tone === 'auto' ? (
        <>
          <svg className="st-half" data-tone="light" x="0" y="0" width="32" height="40" viewBox="0 0 32 40">
            <WindowShapes />
          </svg>
          <svg className="st-half" data-tone="dark" x="32" y="0" width="32" height="40" viewBox="32 0 32 40">
            <WindowShapes />
          </svg>
        </>
      ) : (
        <WindowShapes />
      )}
    </svg>
  );
}

export function ThemeThumbs({ value, onPick }: { value: ThemeChoice; onPick: (next: ThemeChoice) => void }) {
  return (
    <ThumbChoices
      label={t('lookFeel.theme.label')}
      value={value}
      onPick={onPick}
      choices={[
        { value: 'light', label: t('lookFeel.theme.light'), picture: <WindowPicture tone="light" /> },
        { value: 'dim', label: t('lookFeel.theme.dim'), picture: <WindowPicture tone="dim" /> },
        { value: 'dark', label: t('lookFeel.theme.dark'), picture: <WindowPicture tone="dark" /> },
        { value: 'auto', label: t('lookFeel.theme.auto'), picture: <WindowPicture tone="auto" /> },
      ]}
    />
  );
}

/** Where windows go in Individual, as a diagram: three windows in a row, or stepped one over the next. */
function LayoutPicture({ kind }: { kind: 'side_by_side' | 'cascade' }) {
  return (
    <svg className="st-thumb-pic" viewBox="0 0 64 40" aria-hidden="true" data-tone="plain">
      <rect width="64" height="40" rx="4" className="win" />
      {kind === 'side_by_side' ? (
        <>
          <rect x="5" y="8" width="16" height="24" rx="2" className="box" />
          <rect x="24" y="8" width="16" height="24" rx="2" className="box" />
          <rect x="43" y="8" width="16" height="24" rx="2" className="box" />
        </>
      ) : (
        <>
          <rect x="6" y="6" width="30" height="20" rx="2" className="box" />
          <rect x="14" y="12" width="30" height="20" rx="2" className="box" />
          <rect x="22" y="18" width="30" height="16" rx="2" className="box front" />
        </>
      )}
    </svg>
  );
}

export function LayoutThumbs({ value, onPick }: { value: 'side_by_side' | 'cascade'; onPick: (next: 'side_by_side' | 'cascade') => void }) {
  return (
    <ThumbChoices
      label={t('lookFeel.layout.label')}
      value={value}
      onPick={onPick}
      choices={[
        { value: 'side_by_side', label: t('lookFeel.layout.sideBySide'), picture: <LayoutPicture kind="side_by_side" /> },
        { value: 'cascade', label: t('lookFeel.layout.cascade'), picture: <LayoutPicture kind="cascade" /> },
      ]}
    />
  );
}
