// Asks the cockpit to open the "Start crew" sheet (the same one the command palette opens). The cockpit listens.
export const START_CREW_EVENT = 'pm:start-crew';
export function openStartCrew(): void {
  window.dispatchEvent(new CustomEvent(START_CREW_EVENT));
}
