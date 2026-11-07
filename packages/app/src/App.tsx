import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import type { AgentType } from '@potato-workspace/shared';
import { SettingsPanel } from './components/SettingsPanel';

// The home and workspace screens load when first shown, so the first paint stays small.
const HomeDashboard = lazy(() => import('./components/HomeDashboard').then((m) => ({ default: m.HomeDashboard })));
const WorkspaceHeader = lazy(() => import('./components/WorkspaceHeader').then((m) => ({ default: m.WorkspaceHeader })));
const TerminalGrid = lazy(() => import('./components/TerminalGrid').then((m) => ({ default: m.TerminalGrid })));
const PotatoWorkspaceSidebar = lazy(() => import('./components/PotatoWorkspaceSidebar').then((m) => ({ default: m.PotatoWorkspaceSidebar })));
import { usePaneRegistry } from './hooks/usePaneRegistry';
import { useProjectPath } from './hooks/useProjectPath';
import { useBridge } from './hooks/useBridge';
import { clampSidebarWidth, loadSettings, patchSettings, syncPublicSettingsToBridge } from './lib/settings';
import {
  applyRemoteOrchestratorProviderPatch,
  publicSettingsToProviderPatch,
} from './lib/orchestrator-provider-sync';
import { tauri } from './lib/tauri';
import { LoadingScreen } from './components/LoadingScreen';
import { AppUpdateHost } from './components/updates/AppUpdateHost';
import { useBootGate } from './hooks/useBootGate';
import { detachedWindowSizeFromGrid, openDetachedPaneWindow } from './lib/detached-pane-window';

type AppScreen = 'home' | 'workspace';

export default function App() {
  const registry = usePaneRegistry();
  const { projectPath, setProjectPath, ready: projectReady } = useProjectPath();
  const bridgeApi = useBridge();
  const [screen, setScreen] = useState<AppScreen>('home');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsRevision, setSettingsRevision] = useState(0);
  const [sidebarWidth, setSidebarWidth] = useState(360);
  const [runPaneIds, setRunPaneIds] = useState<Set<string>>(() => new Set());
  const [detachedPaneIds, setDetachedPaneIds] = useState<Set<string>>(() => new Set());
  const bumpSettings = useCallback(() => setSettingsRevision((n) => n + 1), []);
  const markPaneDetached = useCallback((paneId: string) => {
    setDetachedPaneIds((prev) => {
      if (prev.has(paneId)) return prev;
      const next = new Set(prev);
      next.add(paneId);
      return next;
    });
  }, []);
  const markPaneAttached = useCallback((paneId: string) => {
    setDetachedPaneIds((prev) => {
      if (!prev.has(paneId)) return prev;
      const next = new Set(prev);
      next.delete(paneId);
      return next;
    });
  }, []);

  useEffect(() => {
    void loadSettings().then((loaded) => setSidebarWidth(clampSidebarWidth(loaded.sidebar_width ?? 360)));
  }, [settingsRevision]);
  const boot = useBootGate({
    projectReady,
    bridgeReady: bridgeApi.isReady,
    registryReady: registry.initialReady,
  });

  useEffect(() => {
    void syncPublicSettingsToBridge();
    let cancelled = false;
    let unlistenApply: (() => void) | null = null;
    let unlistenDetach: (() => void) | null = null;
    let unlistenReattach: (() => void) | null = null;
    let unlistenShowInGrid: (() => void) | null = null;

    void (async () => {
      unlistenDetach = await tauri.onPaneDetach((event) => {
        void (async () => {
          try {
            setScreen('workspace');
            await openDetachedPaneWindow(
              event.pane_id,
              event.title ?? `Pane ${event.pane_id.slice(0, 8)}`,
              detachedWindowSizeFromGrid(event.cols, event.rows),
              { background: true },
            );
            markPaneDetached(event.pane_id);
          } catch (err) {
            console.error('[App] failed to detach pane', err);
          }
        })();
      });
      // An agent run's visible pane lives in the left grid: show the Workspace (no focus steal).
      unlistenShowInGrid = await tauri.onPaneShowInGrid((event) => {
        setRunPaneIds((prev) => new Set(prev).add(event.pane_id));
        setScreen('workspace');
      });
      unlistenReattach = await tauri.onPaneReattach((event) => {
        markPaneAttached(event.pane_id);
        setScreen('workspace');
      });
      unlistenApply = await tauri.onSettingsApply(async (patch) => {
        const providerPatch = publicSettingsToProviderPatch(patch);
        if (providerPatch.backend || providerPatch.provider || providerPatch.model) {
          await applyRemoteOrchestratorProviderPatch(providerPatch);
        }

        if (typeof patch.mobile_input_delay_ms === 'number' || typeof patch.mobile_input_visible === 'boolean') {
          const changed: { mobile_input_delay_ms?: number; mobile_input_visible?: boolean } = {};
          if (typeof patch.mobile_input_delay_ms === 'number') changed.mobile_input_delay_ms = patch.mobile_input_delay_ms;
          if (typeof patch.mobile_input_visible === 'boolean') changed.mobile_input_visible = patch.mobile_input_visible;
          await patchSettings(changed);
        }

        bumpSettings();
      });
      if (cancelled) {
        // StrictMode / hot reload can run cleanup before these async listeners resolve:
        // a leaked pane://detach listener opens a second window for every pane.
        unlistenDetach?.();
        unlistenReattach?.();
        unlistenShowInGrid?.();
        unlistenApply?.();
      }
    })();

    return () => {
      cancelled = true;
      unlistenDetach?.();
      unlistenReattach?.();
      unlistenShowInGrid?.();
      unlistenApply?.();
    };
  }, [bumpSettings, markPaneAttached, markPaneDetached]);

  const handleClose = async (paneId: string) => {
    await registry.killPane(paneId);
  };
  const handleKillAll = async () => {
    await registry.killAll();
  };
  const handleRestart = async () => {
    await registry.killAll();
  };
  const handleClear = () => {
    void registry.refresh();
  };

  const handleNewSession = async (agent: AgentType) => {
    await registry.spawnPane({ agent_type: agent, cwd: projectPath ?? undefined });
  };

  return (
    <>
      {boot.showBoot && (
        <LoadingScreen steps={boot.steps} progress={boot.progress} exiting={boot.exiting} />
      )}

      {!boot.showBoot && screen === 'home' && (
        <Suspense fallback={null}>
        <HomeDashboard
          projectPath={projectPath}
          bridgeReady={bridgeApi.isReady}
          bridgeError={bridgeApi.error}
          registry={registry}
          settingsRevision={settingsRevision}
          onOpenWorkspace={() => setScreen('workspace')}
          onOpenSettings={() => setSettingsOpen(true)}
          onProjectPathChange={setProjectPath}
        />
        </Suspense>
      )}

      {!boot.showBoot && screen === 'workspace' && (
        <Suspense fallback={null}>
        <div className="flex flex-col h-full pm-workspace-enter">
          <WorkspaceHeader
            projectPath={projectPath}
            onProjectPathChange={setProjectPath}
            onKillAll={handleKillAll}
            onRestart={handleRestart}
            onClearBuffers={handleClear}
            onNewSession={handleNewSession}
            onGoHome={() => setScreen('home')}
          />
          <div className="flex flex-1 min-h-0">
            <TerminalGrid
              registry={registry}
              projectPath={projectPath}
              onClosePane={handleClose}
              detachedPaneIds={detachedPaneIds}
              runPaneIds={runPaneIds}
              onDetachPane={markPaneDetached}
            />
            <div
              role="separator"
              aria-orientation="vertical"
              title="Resize sidebar"
              className="w-1 shrink-0 cursor-col-resize bg-pm-border/60 hover:bg-pm-accent transition-colors touch-none"
              onPointerDown={(event) => {
                event.preventDefault();
                const startX = event.clientX;
                const startWidth = sidebarWidth;
                const target = event.currentTarget;
                target.setPointerCapture(event.pointerId);

                const move = (moveEvent: globalThis.PointerEvent) => {
                  const delta = startX - moveEvent.clientX;
                  const next = clampSidebarWidth(startWidth + delta);
                  setSidebarWidth(next);
                  void patchSettings({ sidebar_width: next });
                };
                const up = (upEvent: globalThis.PointerEvent) => {
                  target.releasePointerCapture(upEvent.pointerId);
                  target.removeEventListener('pointermove', move);
                  target.removeEventListener('pointerup', up);
                  target.removeEventListener('pointercancel', up);
                };
                target.addEventListener('pointermove', move);
                target.addEventListener('pointerup', up);
                target.addEventListener('pointercancel', up);
              }}
            />
            <PotatoWorkspaceSidebar
              width={sidebarWidth}
              bridge={bridgeApi.client}
              bridgeReady={bridgeApi.isReady}
              externalLogs={bridgeApi.externalLogs}
              registry={registry}
              projectPath={projectPath}
              onShowSettings={() => setSettingsOpen(true)}
              settingsRevision={settingsRevision}
            />
          </div>
        </div>
        </Suspense>
      )}

      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={bumpSettings}
        projectPath={projectPath}
        onProjectPathChange={setProjectPath}
      />

      {!boot.showBoot && <AppUpdateHost />}
    </>
  );
}
