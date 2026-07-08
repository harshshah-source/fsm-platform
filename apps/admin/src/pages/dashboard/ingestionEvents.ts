// Tiny pub/sub bridge for the manual ingestion trigger. The "Run Ingestion Now" button now lives in the
// top bar (chrome), while the KPI odometers that must roll to fresh values on a completed run live in the
// Operations-Head dashboard. Rather than thread a callback through the shell, the button broadcasts a
// completion event and the dashboard subscribes to it — same wiring the button's `onSuccess` provided
// before, just decoupled across the tree.

type Listener = () => void;

const listeners = new Set<Listener>();

/** Subscribe to "a manual ingestion run completed". Returns an unsubscribe fn (call it on unmount). */
export function onIngestionComplete(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Fire the completion event — the button passes this as its `onSuccess`. */
export function emitIngestionComplete(): void {
  for (const fn of [...listeners]) fn();
}
