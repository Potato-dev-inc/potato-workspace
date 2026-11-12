/// <reference types="vite-plugin-pwa/client" />
import { lazy, StrictMode, Suspense, type ComponentType } from 'react';
import ReactDOM from 'react-dom/client';
import { tauri } from './lib/tauri';
import { isTauriWindow, setupServiceWorker } from './lib/service-worker';
import { isSettingsEntry } from './lib/settings-entry';
import './styles/index.css';

// The other windows and modes load their own code only when they open, so the first screen stays small.
const AskBarApp = lazy(() => import('./components/askbar/AskBarApp'));
const PointBoxApp = lazy(() => import('./components/point/PointBoxApp'));
const MiniBarApp = lazy(() => import('./components/minibar/MiniBarApp'));
const SwitchOverlayApp = lazy(() => import('./components/switchoverlay/SwitchOverlayApp'));
const CockpitApp = lazy(() => import('./CockpitApp'));
const PwaApp = lazy(() => import('./PwaApp'));
const SettingsApp = lazy(() => import('./SettingsApp'));
const TerminalApp = lazy(() => import('./TerminalApp'));
const WorkerHostBootstrap = lazy(() => import('./WorkerHostBootstrap'));

// Phone PWA only; inside the desktop app a service worker left by an older version is removed.
void setupServiceWorker({
  inDesktopApp: isTauriWindow(),
  container: 'serviceWorker' in navigator ? navigator.serviceWorker : undefined,
  cacheStorage: typeof caches === 'undefined' ? undefined : caches,
  register: () => import('virtual:pwa-register').then(({ registerSW }) => registerSW({ immediate: true })),
}).catch(() => undefined);

const params = new URLSearchParams(window.location.search);
const isTerminalApp = params.has('terminal') || params.has('cmd') || window.location.hash === '#terminal';
const isStandaloneWorker =
  params.has('worker') || import.meta.env.VITE_POTATO_WORKSPACE_WORKER === '1';
const isMobileOrPwa =
  params.has('pwa') ||
  window.matchMedia('(display-mode: standalone)').matches ||
  /Android|iPhone|iPad/i.test(navigator.userAgent);

type RootComponent = ComponentType;

async function resolveRoot(): Promise<RootComponent> {
  // Dev-only UI evidence harness (tree-shaken from production builds).
  if (import.meta.env.DEV && params.has('harness')) {
    const { bootHarness } = await import('./dev/harness');
    return (await bootHarness(params.get('harness') ?? '')) as RootComponent;
  }
  if (isSettingsEntry(window.location.search)) return SettingsApp;
  if (params.get('cockpit') === '1') return CockpitApp;
  if (params.get('askbar') === '1') return AskBarApp;
  if (params.get('pointbox') === '1') return PointBoxApp;
  if (params.get('minibar') === '1') return MiniBarApp;
  if (params.get('switchoverlay') === '1') return SwitchOverlayApp;
  if (isTerminalApp) return TerminalApp;
  if (isStandaloneWorker) return WorkerHostBootstrap;
  if (isMobileOrPwa) return PwaApp;
  try {
    const workerLaunch = await tauri.getWorkerLaunch();
    if (workerLaunch) return WorkerHostBootstrap;
  } catch {
    /* browser preview */
  }
  return CockpitApp;
}

// StrictMode is safe: TerminalSession defers terminal creation to the next
// animation frame so the first StrictMode mount can dispose before heavy
// renderer work is scheduled.
void resolveRoot().then((Root) => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Suspense fallback={null}>
        <Root />
      </Suspense>
    </StrictMode>,
  );
});
