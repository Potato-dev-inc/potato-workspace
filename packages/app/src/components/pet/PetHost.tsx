import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Pet } from './Pet';
import type { PetSizeName } from './PetMenu';
import type { PetNeed } from './petModel';
import type { PetApi } from './petApi';
import { usePetController, type PetEnv } from './usePetController';

/** A run that just finished. `n` changes with every one, so two in a row for the same agent both count. */
export interface PetFinished {
  n: number;
  agent: string;
  paneId?: string;
}

export interface PetHostProps {
  needs: PetNeed[];
  finished: PetFinished | null;
  /** A line the companion wants said (reserved for the companion's speak rules). */
  say?: { n: number; text: string } | null;
  size: PetSizeName;
  /** The person's Quiet choice. */
  quietChoice: boolean;
  /** Quiet right now: the choice, or quiet hours. */
  quiet: boolean;
  lessMotion: boolean;
  api: PetApi;
  env: PetEnv;
  /** A hook for tests and the headless pictures. */
  onModel?: (model: ReturnType<typeof usePetController>['model']) => void;
}

/** Desktop Potato with its inputs as props (the window reads them from the app; tests pass them in). */
export function PetHost(props: PetHostProps) {
  const { needs, finished, say, quiet, api, env, size } = props;
  const { view, model, dispatch } = usePetController(env, props.lessMotion);

  useEffect(() => props.onModel?.(model));
  useEffect(() => dispatch({ type: 'quiet', on: quiet }), [quiet, dispatch]);
  const needsKey = needs.map((n) => `${n.key}|${n.paneId ?? ''}|${n.agent}`).join('\n');
  useEffect(() => dispatch({ type: 'needs', needs }), [needsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const lastFinished = useRef<number | null>(null);
  useEffect(() => {
    if (!finished || finished.n === lastFinished.current) return;
    lastFinished.current = finished.n;
    dispatch({ type: 'finished', agent: finished.agent, paneId: finished.paneId });
  }, [finished, dispatch]);
  const lastSay = useRef<number | null>(null);
  useEffect(() => {
    if (!say || say.n === lastSay.current) return;
    lastSay.current = say.n;
    dispatch({ type: 'say', text: say.text });
  }, [say, dispatch]);

  // A drag ends when the app says the window stopped moving; if that word never comes, let go after a while.
  const dragging = model.dragging;
  useEffect(() => {
    if (!dragging) return;
    let live = true;
    let off: (() => void) | undefined;
    void api.onMoved(() => dispatch({ type: 'dragEnd' })).then((fn) => (live ? (off = fn) : fn()));
    const failsafe = setTimeout(() => dispatch({ type: 'dragEnd' }), 20_000);
    return () => {
      live = false;
      off?.();
      clearTimeout(failsafe);
    };
  }, [dragging, api, dispatch]);

  const onExpandedChange = useCallback((expanded: boolean) => api.setExpanded(expanded), [api]);
  const onDragStart = useCallback(() => {
    dispatch({ type: 'dragStart' });
    api.startDrag();
  }, [api, dispatch]);
  const openAgent = useCallback(
    (paneId?: string) => {
      api.openAgent(paneId);
      dispatch({ type: 'dismiss' });
    },
    [api, dispatch],
  );

  return useMemo(
    () => (
      <Pet
        view={view}
        size={size}
        quietChoice={props.quietChoice}
        onOpenAgent={openAgent}
        onLater={() => dispatch({ type: 'later' })}
        onDismiss={() => dispatch({ type: 'dismiss' })}
        onDragStart={onDragStart}
        onHide={() => api.patch({ desktop_pet_hidden_until_ms: Date.now() + 60 * 60_000 })}
        onSize={(next) => api.patch({ desktop_pet_size: next })}
        onQuiet={() => api.patch({ desktop_pet_quiet: !props.quietChoice })}
        onOff={() => api.patch({ desktop_pet_enabled: false })}
        onExpandedChange={onExpandedChange}
        onTouch={() => dispatch({ type: 'touch' })}
      />
    ),
    [view, size, props.quietChoice, openAgent, dispatch, onDragStart, api, onExpandedChange],
  );
}
