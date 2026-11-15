// The small picture beside a file or folder name: the Material Icon Theme icon for its name (lib/material-icons).
// Decorative: the name is beside it. Until the pictures load (one small chunk, once) an empty box of the same size
// holds the place, so rows do not jump.
import { fileIconId, folderIconId, hasLightVariant, iconSvg, useIconSvgs } from '../../../lib/material-icons';

export function FileGlyph({ name, dir = false, open = false }: { name: string; /** A folder. */ dir?: boolean; /** An open folder. */ open?: boolean }) {
  const svgs = useIconSvgs();
  const id = dir ? folderIconId(name, open) : fileIconId(name);
  if (!svgs) return <i className="mi mi--wait" aria-hidden="true" />;
  const dark = iconSvg(svgs, id);
  if (!hasLightVariant(id.replace(/-open$/, '')) && !hasLightVariant(id)) {
    return <i className="mi" data-icon={id} aria-hidden="true" dangerouslySetInnerHTML={{ __html: dark }} />;
  }
  return (
    <i className="mi mi--themed" data-icon={id} aria-hidden="true">
      <span className="mi-d" dangerouslySetInnerHTML={{ __html: dark }} />
      <span className="mi-l" dangerouslySetInnerHTML={{ __html: iconSvg(svgs, id, true) }} />
    </i>
  );
}
