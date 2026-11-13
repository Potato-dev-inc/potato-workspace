// The permission chip in the message box: which of an agent's modes mean "it may do anything without asking".
// The agent's own mode list is the source (names come from the agent over ACP); this only spots the wording that
// means no questions are asked, so the chip turns warning-yellow for those and stays neutral for the safe modes.
import type { ConfigChip } from '../../lib/acpChat';

const FULL_ACCESS = /full[\s_-]*access|bypass|yolo|dangerous|skip[\s_-]*permission|auto[\s_-]*approve|never[\s_-]*ask/i;

/** True when this mode lets the agent act with no questions asked. */
export function isFullAccessMode(choice: { value: string; name: string } | undefined): boolean {
  return !!choice && (FULL_ACCESS.test(choice.value) || FULL_ACCESS.test(choice.name));
}

/** The mode setting (the permission chip), if the agent offers one. */
export function isPermissionChip(chip: ConfigChip): boolean {
  return chip.category === 'mode';
}

/** The chip with the permission setting first: add, permission, model, effort. */
export function permissionFirst(chips: ConfigChip[]): ConfigChip[] {
  return [...chips.filter(isPermissionChip), ...chips.filter((c) => !isPermissionChip(c))];
}
