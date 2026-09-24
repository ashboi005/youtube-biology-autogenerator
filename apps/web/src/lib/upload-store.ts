import { useSyncExternalStore } from "react";

/**
 * Upload state lives outside React so it survives a step card being collapsed (unmounted)
 * while the upload keeps running.
 */
type State = { active: ReadonlySet<string>; progress: Readonly<Record<string, number>>; pending: number };

let state: State = { active: new Set(), progress: {}, pending: 0 };
const listeners = new Set<() => void>();
const emit = (next: State) => {
  state = next;
  for (const l of listeners) l();
};

export const uploadStore = {
  start(id: string) {
    emit({ ...state, active: new Set(state.active).add(id) });
  },
  finish(id: string) {
    const active = new Set(state.active);
    active.delete(id);
    emit({ ...state, active });
  },
  progress(id: string, fraction: number) {
    emit({ ...state, progress: { ...state.progress, [id]: fraction } });
  },
  pending(delta: number) {
    emit({ ...state, pending: Math.max(0, state.pending + delta) });
  },
};

export function useUploads(): State {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state,
  );
}
