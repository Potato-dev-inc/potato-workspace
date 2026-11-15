/** The Settings window itself. The cockpit also keeps a see-through `.settings.jl-host` layer for the join popup
 *  (`pointer-events: none`, so everything drawn inside it ignores the mouse) and first-run has `.settings.fr-settings-scope`:
 *  neither is a window, so a sheet must never be put in them. */
export const SETTINGS_WINDOW = '.settings:not(.jl-host):not(.fr-settings-scope)';

/** Where a sheet is drawn: the Settings window, else the cockpit (null when there is no page, e.g. a test). */
export const sheetHost = (): Element | null => (typeof document === 'undefined' ? null : (document.querySelector(SETTINGS_WINDOW) ?? document.querySelector('.cockpit')));
