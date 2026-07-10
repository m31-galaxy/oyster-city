import { atom } from "tldraw";

// Live line-status state shared between the poll loop (which knows which
// lines are fully closed) and the line shape components (which dim them).
// Same reactive-atom pattern as lib/tube/labels.ts: components subscribe
// via useValue and re-render only when their own answer flips.

/** Line ids currently FULLY closed (no trains anywhere — nightly shutdown,
 * suspension, whole-line engineering). Written by TubeMap's poll from the
 * same status data that gates ghost trains; read by TubeLineShapeUtil to
 * dim the line's geometry. */
export const closedLines = atom<ReadonlySet<string>>("closedLines", new Set());
