// A tiny page icon in the colour of the file's type (tokens --ft-*). Decorative: the file name is beside it.
import { fileTone } from './fileKind';

export function FileGlyph({ name }: { name: string }) {
  return <i className={`rp-ft rp-ft--${fileTone(name)}`} aria-hidden="true" />;
}
