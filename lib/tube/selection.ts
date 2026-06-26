// Tiny pub/sub so a station tap inside the tldraw canvas can reach React UI
// outside it (the sidebar) without threading props through tldraw's internals.

export interface SelectedStation {
  id: string;
  name: string;
}

type Listener = (station: SelectedStation | null) => void;

const listeners = new Set<Listener>();
let current: SelectedStation | null = null;

export function selectStation(station: SelectedStation | null): void {
  current = station;
  for (const listener of listeners) listener(station);
}

export function getSelectedStation(): SelectedStation | null {
  return current;
}

export function onStationSelect(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
