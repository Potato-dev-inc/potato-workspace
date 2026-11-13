// Desktop Potato: runs the pet's rules (petModel) with real time. One timer, set for the next deadline; nothing
// ticks while the pet just sits there. Blinking and the rare walk are the only things scheduled on their own.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { newPet, nextDeadline, petReduce, petView, type PetEvent, type PetModel, type PetView } from './petModel';

export interface PetEnv {
  now: () => number;
  random: () => number;
  /** Move the window sideways by `dx` px; true when an edge stopped it. */
  moveBy: (dx: number) => Promise<boolean>;
  /** A full-screen app or game in front? `null`: cannot tell. */
  fullscreenBusy: () => Promise<boolean | null>;
}

export const BLINK_EVERY_MS: readonly [number, number] = [8_000, 14_000];
/** A walk is rare: one try every 2 to 5 minutes, and only while awake and idle. */
export const WALK_EVERY_MS: readonly [number, number] = [120_000, 300_000];
export const WALK_MS: readonly [number, number] = [2_000, 4_000];
const WALK_STEP_MS = 100;
const WALK_STEP_PX = 6;

const between = (range: readonly [number, number], r: number) => Math.round(range[0] + (range[1] - range[0]) * r);

export interface PetController {
  view: PetView;
  model: PetModel;
  dispatch: (event: PetEvent) => void;
}

export function usePetController(env: PetEnv, lessMotion: boolean): PetController {
  const [state, setState] = useState(() => {
    const now = env.now();
    return { model: newPet(now), now };
  });
  const model = state.model;
  const modelRef = useRef(model);
  modelRef.current = model;

  const dispatch = useCallback(
    (event: PetEvent) => {
      const at = env.now();
      setState((s) => ({ model: petReduce(s.model, event, at), now: at }));
    },
    [env],
  );

  // The one timer: wake at the next moment something changes by itself.
  useEffect(() => {
    const next = nextDeadline(state.model, state.now);
    if (next === null) return;
    const id = setTimeout(() => dispatch({ type: 'tick' }), Math.max(20, next - env.now() + 5));
    return () => clearTimeout(id);
  }, [state, env, dispatch]);

  const view = useMemo(() => petView(state.model, state.now, lessMotion), [state, lessMotion]);

  // Awake and idle: an occasional blink.
  const blinking = view.sprite === 'idle' && !lessMotion;
  useEffect(() => {
    if (!blinking) return;
    const id = setTimeout(() => dispatch({ type: 'blink' }), between(BLINK_EVERY_MS, env.random()));
    return () => clearTimeout(id);
  }, [blinking, env, dispatch, state.model.blinkUntil]);

  // Awake and idle: now and then, a short walk along the bottom of the screen. Never with Less motion, never when a
  // full-screen app is in front, and never when this computer cannot say whether one is.
  const [walkRound, setWalkRound] = useState(0);
  // (A blink in between does not count as leaving idle: it must not restart the walk timer.)
  const mayWalk = (view.sprite === 'idle' || view.sprite === 'blink') && !lessMotion;
  useEffect(() => {
    if (!mayWalk) return;
    let live = true;
    const id = setTimeout(() => {
      void env.fullscreenBusy().then(
        (busy) => {
          if (live && busy === false) {
            dispatch({ type: 'walkStart', dir: env.random() < 0.5 ? 'left' : 'right', ms: between(WALK_MS, env.random()) });
          }
          if (live) setWalkRound((n) => n + 1);
        },
        () => live && setWalkRound((n) => n + 1),
      );
    }, between(WALK_EVERY_MS, env.random()));
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [mayWalk, walkRound, env, dispatch]);

  // While it walks, one small step every tenth of a second; an edge ends the walk.
  const walkDir = state.model.walk?.dir ?? null;
  useEffect(() => {
    if (!walkDir) return;
    let live = true;
    const id = setInterval(() => {
      void env.moveBy(walkDir === 'left' ? -WALK_STEP_PX : WALK_STEP_PX).then((hit) => {
        if (live && hit) dispatch({ type: 'walkEnd' });
      });
    }, WALK_STEP_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [walkDir, env, dispatch]);

  return { view, model, dispatch };
}
