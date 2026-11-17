// "Open this helper" asked from somewhere that has no pane list of its own (the crew canvas's Live tab). The cockpit listens:
// a spin-off opens as a chat, a minion as the read-only view in the chat that started it (the same as the crew chip's rows).
export const OPEN_HELPER_EVENT = 'pm:open-helper';

export function requestOpenHelper(parentId: string, id: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_HELPER_EVENT, { detail: { parentId, id } }));
}
