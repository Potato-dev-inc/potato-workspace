// @vitest-environment node
// The Point box route (`index.html?pointbox=1`) resolves to the Point box root, next to the askbar route.
// Node environment on purpose: main.tsx imports `virtual:pwa-register`, which only the app's Vite config
// (with the PWA plugin) can resolve; in node (SSR transform) that import is left for runtime and never runs here.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// main.tsx reads the window and the document when it loads. Node has neither, so a small stand-in
// carries the query string; the test sets `location.search` before each load.
const dom = vi.hoisted(() => {
  const location = { search: '', hash: '' };
  Object.assign(globalThis, {
    window: {
      location,
      history: { replaceState: () => undefined },
      matchMedia: () => ({ matches: false }),
    },
    document: { getElementById: () => ({}) },
  });
  return { location };
});

// The element main.tsx hands to ReactDOM (`<StrictMode><Root /></StrictMode>`), captured by the mocked renderer.
const rendered = vi.hoisted(() => ({ element: null as unknown }));

vi.mock('react-dom/client', () => ({
  default: {
    createRoot: () => ({
      render: (element: { props: { children: unknown } }) => {
        rendered.element = element;
      },
    }),
  },
}));

// Heavy roots and desktop plumbing are replaced by empty components: only the route choice matters here.
vi.mock('./components/askbar/AskBarApp', () => ({ default: () => null }));
vi.mock('./CockpitApp', () => ({ default: () => null }));
vi.mock('./PwaApp', () => ({ default: () => null }));
vi.mock('./SettingsApp', () => ({ default: () => null }));
vi.mock('./TerminalApp', () => ({ default: () => null }));
vi.mock('./WorkerHostBootstrap', () => ({ default: () => null }));
vi.mock('./lib/service-worker', () => ({
  isTauriWindow: () => false,
  setupServiceWorker: async () => 'unsupported',
}));
vi.mock('./lib/tauri', () => ({ tauri: { getWorkerLaunch: async () => null } }));

/** The React.lazy shape main.tsx's lazy roots have (only its loader is read here). */
type Lazyish = { _init?: (payload: unknown) => unknown; _payload?: unknown };

/**
 * Loads main.tsx fresh for a query string. Returns the component it chose to render, and the
 * components of the same (fresh) module graph, so identity checks compare like with like.
 */
async function loadRouteFor(search: string) {
  vi.resetModules();
  dom.location.search = search;
  rendered.element = null;
  const { PointBoxApp } = await import('./components/point/PointBoxApp');
  const { default: CockpitApp } = await import('./CockpitApp');
  const { default: PwaApp } = await import('./PwaApp');
  const { default: AskBarApp } = await import('./components/askbar/AskBarApp');
  await import('./main');
  await vi.waitFor(() => {
    expect(rendered.element).not.toBeNull();
  });
  const outer = rendered.element as { props: { children: { props: { children: { type: Lazyish } } } } } | null;
  if (!outer) throw new Error('main.tsx rendered nothing');
  // main.tsx lazy-loads the other roots, so a chosen root sits behind React.lazy inside Suspense. 
  const chosen = outer.props.children.props.children.type;
  const Root = chosen._init ? await vi.waitFor(() => chosen._init!(chosen._payload)) : chosen;
  return { Root, PointBoxApp, CockpitApp, PwaApp, AskBarApp };
}

describe('main.tsx point box route', () => {
  // The first load pulls in the whole app module graph. Transforming that cold graph takes 2 to 4 s on a busy
  // PC (measured), so the first route test used to spend its 5 s limit on it. Warming the graph once here, under
  // its own limit, leaves each route check to measure only the route. Every test still loads main.tsx fresh.
  beforeAll(async () => {
    await loadRouteFor('');
  }, 60_000);

  beforeEach(() => {
    dom.location.hash = '';
  });

  it('?pointbox=1 renders the Point box root', async () => {
    const { Root, PointBoxApp } = await loadRouteFor('?pointbox=1');
    expect(Root).toBe(PointBoxApp);
  });

  it('a plain window renders the cockpit (there is no older main window any more)', async () => {
    const { Root, CockpitApp } = await loadRouteFor('');
    expect(Root).toBe(CockpitApp);
  });

  it('?pwa=legacy no longer loads the old phone app: it falls through to the current phone app', async () => {
    const { Root, PwaApp } = await loadRouteFor('?pwa=legacy');
    expect(Root).toBe(PwaApp);
    const plain = await loadRouteFor('?pwa=1');
    expect(plain.Root).toBe(plain.PwaApp);
  });

  it('pointbox=0 does not switch to the Point box', async () => {
    const { Root, PointBoxApp } = await loadRouteFor('?pointbox=0');
    expect(Root).not.toBe(PointBoxApp);
  });

  it('the askbar route is unchanged next to it', async () => {
    const { Root, AskBarApp } = await loadRouteFor('?askbar=1');
    expect(Root).toBe(AskBarApp);
  });
});
