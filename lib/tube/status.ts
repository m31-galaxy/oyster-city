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

/** Network station ids whose EVERY serving line is closed — an interchange
 * stays lit while any of its lines still runs. Derived from closedLines and
 * the static station→lines topology by the same poll (the shape components
 * would otherwise each need their own copy of the topology). Read by
 * StationShapeUtil to dim the marker and label. */
export const closedStations = atom<ReadonlySet<string>>(
  "closedStations",
  new Set(),
);

/** The canvas background (globals.css --bg) that dimmed colours mix toward. */
const DIM_BG = { r: 0xf4, g: 0xf4, b: 0xf5 };
/** Share of the background in a dimmed colour: greyscale the input by
 * luminance, then pull it this far toward the background — dark inputs (the
 * Northern's black, label ink) land as a mid grey instead of staying
 * near-black, and everything closed converges into one quiet family. */
const DIM_MIX = 0.6;
const dimCache = new Map<string, string>();

/** Closed-line/-station colour: luminance greyscale mixed toward the canvas
 * background. Shared by the line, station, and label renderers so the whole
 * closed network dims into the same family. */
export function dimmedColour(hex: string): string {
  const hit = dimCache.get(hex);
  if (hit) return hit;
  const n = parseInt(hex.slice(1), 16);
  const grey = Math.min(
    // Luminance cap: the palest lines (Circle's yellow, Waterloo & City's
    // mint) would otherwise mix to within a few steps of the background
    // and effectively vanish — closed should read as "quiet", not "gone".
    160,
    0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255),
  );
  const mix = (bg: number) => Math.round(grey + (bg - grey) * DIM_MIX);
  const out = `#${((1 << 24) | (mix(DIM_BG.r) << 16) | (mix(DIM_BG.g) << 8) | mix(DIM_BG.b)).toString(16).slice(1)}`;
  dimCache.set(hex, out);
  return out;
}
