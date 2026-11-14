// "Start a chat": a screen that is not the sidebar (the Request usage sheet, once a lend is ready) asks the cockpit to show the
// New agent page. The cockpit registers how; with no cockpit around nothing happens.
let opener: (() => void) | null = null;

export function registerNewAgentOpener(open: (() => void) | null): void {
  opener = open;
}

/** Shows the New agent page. False when no cockpit is listening. */
export function requestNewAgent(): boolean {
  if (!opener) return false;
  opener();
  return true;
}
