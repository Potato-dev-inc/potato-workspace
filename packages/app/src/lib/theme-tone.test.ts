import { describe, expect, it } from 'vitest';
import { isDarkTheme, isThemeChoice, resolveTheme, themeAttrs, toggledTheme } from './theme-tone';

describe('theme-tone', () => {
  it('resolves each choice to a theme and a tone', () => {
    expect(resolveTheme('dark', true)).toEqual({ theme: 'dark', tone: null });
    expect(resolveTheme('light', false)).toEqual({ theme: 'light', tone: null });
    expect(resolveTheme('dim', false)).toEqual({ theme: 'light', tone: 'dim' });
    expect(resolveTheme('auto', true)).toEqual({ theme: 'light', tone: null });
    expect(resolveTheme('auto', false)).toEqual({ theme: 'dark', tone: null });
    expect(resolveTheme(undefined, true)).toEqual({ theme: 'dark', tone: null });
  });
  it('gives data-tone only for the dimmed theme', () => {
    expect(themeAttrs('dim', false)).toEqual({ 'data-theme': 'light', 'data-tone': 'dim' });
    expect(themeAttrs('light', false)).toEqual({ 'data-theme': 'light' });
    expect(themeAttrs('dark', true)).toEqual({ 'data-theme': 'dark' });
  });
  it('toggles dark and light; dimmed goes to dark; auto resolves first', () => {
    expect(toggledTheme('dark')).toBe('light');
    expect(toggledTheme('light')).toBe('dark');
    expect(toggledTheme('dim')).toBe('dark');
    expect(toggledTheme('auto', true)).toBe('dark');
    expect(toggledTheme('auto', false)).toBe('light');
    expect(isDarkTheme('dim', false)).toBe(false);
  });
  it('knows the four stored values', () => {
    for (const v of ['dark', 'light', 'dim', 'auto']) expect(isThemeChoice(v)).toBe(true);
    expect(isThemeChoice('blue')).toBe(false);
  });
});
