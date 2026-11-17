// A logo the person chose for one agent. Saved in this browser's storage by agent id (a small picture as a data URL),
// so nothing is fetched and nothing leaves the computer. It beats the built-in logo for that agent.
import { useSyncExternalStore } from 'react';

export const LS_CUSTOM_LOGOS = 'pm.agentLogos.custom';
export const CUSTOM_LOGOS_EVENT = 'pm:agent-logos-changed';
/** Biggest picture file accepted. A logo is small; a big photo is not one. */
export const MAX_LOGO_BYTES = 150 * 1024;
const OK_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'image/gif'];

function readAll(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LS_CUSTOM_LOGOS) ?? 'null');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter(([, v]) => typeof v === 'string' && v.startsWith('data:image/')) as [string, string][]);
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, string>): void {
  try {
    localStorage.setItem(LS_CUSTOM_LOGOS, JSON.stringify(all));
  } catch {
    /* storage is off or full: the logo lasts until the window closes */
  }
  try {
    window.dispatchEvent(new Event(CUSTOM_LOGOS_EVENT));
  } catch {
    /* no window */
  }
}

let cache: { raw: string | null; all: Record<string, string> } | null = null;
function snapshot(): Record<string, string> {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LS_CUSTOM_LOGOS);
  } catch {
    /* no storage */
  }
  if (!cache || cache.raw !== raw) cache = { raw, all: readAll() };
  return cache.all;
}

export function customLogoFor(agentId: string): string | null {
  return snapshot()[agentId.trim().toLowerCase()] ?? null;
}

export function setCustomLogo(agentId: string, dataUrl: string | null): void {
  const all = { ...readAll() };
  const key = agentId.trim().toLowerCase();
  if (dataUrl) all[key] = dataUrl;
  else delete all[key];
  writeAll(all);
}

/** Read a picked file into a data URL, or say in a short code why not: `type` or `size`. */
export function readLogoFile(file: File): Promise<{ ok: true; dataUrl: string } | { ok: false; why: 'type' | 'size' | 'read' }> {
  if (!OK_TYPES.includes(file.type)) return Promise.resolve({ ok: false, why: 'type' });
  if (file.size > MAX_LOGO_BYTES) return Promise.resolve({ ok: false, why: 'size' });
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' && reader.result.startsWith('data:image/') ? { ok: true, dataUrl: reader.result } : { ok: false, why: 'read' });
    reader.onerror = () => resolve({ ok: false, why: 'read' });
    reader.readAsDataURL(file);
  });
}

function subscribe(cb: () => void): () => void {
  window.addEventListener(CUSTOM_LOGOS_EVENT, cb);
  window.addEventListener('storage', cb);
  return () => {
    window.removeEventListener(CUSTOM_LOGOS_EVENT, cb);
    window.removeEventListener('storage', cb);
  };
}

/** The agent's custom logo (a data URL) or null; re-renders when it changes. */
export function useCustomLogo(agentId: string): string | null {
  return useSyncExternalStore(subscribe, () => customLogoFor(agentId), () => null);
}
