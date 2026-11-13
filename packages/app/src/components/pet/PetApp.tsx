import { useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useAttention } from '../../hooks/useAttention';
import { useAgentRegistry } from '../../lib/agentRegistry';
import { reducedMotion } from '../../lib/comfort/model';
import { useComfort } from '../../lib/comfort/store';
import { loadNotifyPrefs, readQuiet } from '../../lib/notify-store';
import { applyTheme, loadSettings } from '../../lib/settings';
import { tauri } from '../../lib/tauri';
import type { PaneInfo } from '../../lib/tauri-types';
import '../../styles/pet.css';
import { PetHost, type PetFinished } from './PetHost';
import type { PetSizeName } from './PetMenu';
import { tauriPetApi } from './petApi';
import { finishedRun, needsFromSnapshot, petIsQuiet, plainAgentName } from './petSources';
import type { PetEnv } from './usePetController';

const env: PetEnv = {
  now: () => Date.now(),
  random: () => Math.random(),
  ...tauriPetApi.env,
};

interface PetSettings {
  enabled: boolean;
  size: PetSizeName;
  quiet: boolean;
}

function readPetSettings(s: Awaited<ReturnType<typeof loadSettings>>): PetSettings {
  const size = s.desktop_pet_size;
  return { enabled: s.desktop_pet_enabled === true, size: size === 'small' || size === 'large' ? size : 'medium', quiet: s.desktop_pet_quiet === true };
}

/** The Desktop Potato window (`index.html?pet=1`). The app creates it only while the Labs switch is on. */
export default function PetApp() {
  const [settings, setSettings] = useState<PetSettings | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [finished, setFinished] = useState<{ n: number; paneId: string; agentType: string } | null>(null);
  const [prefs] = useComfort();
  const listing = useAgentRegistry();
  const snapshot = useAttention();

  // Settings: read once, then again whenever any window saves.
  useEffect(() => {
    let live = true;
    const read = () =>
      void loadSettings().then(
        (s) => {
          if (!live) return;
          setSettings(readPetSettings(s));
          applyTheme(s.theme ?? 'dark');
        },
        () => undefined,
      );
    document.documentElement.classList.add('pet-page');
    read();
    const off = listen('settings://changed', read);
    return () => {
      live = false;
      void off.then((fn) => fn());
    };
  }, []);

  // Quiet hours are checked once a minute; nothing else polls.
  useEffect(() => {
    void loadNotifyPrefs();
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  // A run that finished: a pane that was running goes idle.
  const panes = useRef(new Map<string, PaneInfo>());
  useEffect(() => {
    let live = true;
    const known = new Map<string, string>();
    let count = 0;
    const offs: Array<() => void> = [];
    void tauri.listPanes().then((list) => {
      for (const p of list) {
        panes.current.set(p.id, p);
        known.set(p.id, p.status);
      }
    });
    const subs = [
      tauri.onPanesChanged(() =>
        void tauri.listPanes().then((list) => {
          for (const p of list) panes.current.set(p.id, p);
        }),
      ),
      tauri.onPtyStatus((e) => {
        const pane = finishedRun(known, e, (id) => panes.current.get(id));
        if (pane && live) setFinished({ n: ++count, paneId: pane.id, agentType: pane.agent_type });
      }),
    ];
    for (const sub of subs) void sub.then((off) => (live ? offs.push(off) : off()));
    return () => {
      live = false;
      offs.forEach((off) => off());
    };
  }, []);

  const nameOf = useMemo(() => (id: string) => listing.agents.find((a) => a.id === id)?.label || plainAgentName(id), [listing]);
  const needs = useMemo(() => needsFromSnapshot(snapshot, nameOf), [snapshot, nameOf]);
  const finishedNamed = useMemo<PetFinished | null>(() => {
    if (!finished) return null;
    return { n: finished.n, paneId: finished.paneId, agent: finished.agentType ? nameOf(finished.agentType) : plainAgentName('') };
  }, [finished, nameOf]);

  if (!settings?.enabled) return null;
  const systemReduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  return (
    <PetHost
      needs={needs}
      finished={finishedNamed}
      size={settings.size}
      quietChoice={settings.quiet}
      quiet={petIsQuiet(settings.quiet, readQuiet(), now)}
      lessMotion={reducedMotion(prefs, systemReduce)}
      api={tauriPetApi}
      env={env}
    />
  );
}
