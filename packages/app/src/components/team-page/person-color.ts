// One of six muted hues per person, from a hash of their member id: the same person has the same colour on every PC.
// The hue is used on the avatar circle only (the CSS gives each index its colour).

export const PERSON_HUES = 6;

/** 0..5, stable for an id (FNV-1a). */
export function personHue(memberId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < memberId.length; i++) {
    h ^= memberId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % PERSON_HUES;
}

/** "RG" for "Rudransh Garg", "M" for "Maya". Letters only. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = [...words[0]][0] ?? '?';
  const last = words.length > 1 ? ([...words[words.length - 1]][0] ?? '') : '';
  return (first + last).toUpperCase();
}
