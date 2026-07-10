import { atom } from "tldraw";

// Live line-status state shared between the poll loop (which knows which
// lines are fully closed), the debug panel (which can override that), and
// the shape components (which dim closed lines/stations). Components
// subscribe via useValue and re-render only when their own answer flips —
// the same reactive-atom pattern as lib/tube/labels.ts.
//
// Data flow: the poll publishes the RAW polled closure set and TubeMap's
// mount publishes the station->lines topology; debug overrides layer on
// top; republish() derives the effective closed-line and closed-station
// sets and change-checks them into the atoms below.

/** Line ids currently EFFECTIVELY fully closed (no trains anywhere —
 * nightly shutdown, suspension, whole-line engineering — or a debug-panel
 * override). Read by TubeLineShapeUtil to dim the line's geometry and by
 * the poll to gate ghost trains. */
export const closedLines = atom<ReadonlySet<string>>("closedLines", new Set());

/** Network station ids whose EVERY serving line is closed — an interchange
 * stays lit while any of its lines still runs. Derived here from
 * closedLines and the static station→lines topology (the shape components
 * would otherwise each need their own copy of the topology). Read by
 * StationShapeUtil to dim the marker and label. */
export const closedStations = atom<ReadonlySet<string>>(
  "closedStations",
  new Set(),
);

/** Bumped on every override change so the poll loop can re-gate trains
 * immediately instead of waiting out the poll interval. */
export const lineOverridesRev = atom("lineOverridesRev", 0);

/** The closure set as last polled from the status API, before overrides. */
let polledClosed: ReadonlySet<string> = new Set();
/** Network station id -> ids of the lines serving it (static topology). */
let stationTopology: ReadonlyMap<string, readonly string[]> = new Map();
/** Debug-panel overrides: lineId -> forced closed? Absent = live status. */
const overrides = new Map<string, boolean>();

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/** Recompute the effective sets and publish (only on actual change — each
 * atom write re-renders every component whose answer flips). */
function republish(): void {
  const eff = new Set(polledClosed);
  for (const [id, forcedClosed] of overrides) {
    if (forcedClosed) eff.add(id);
    else eff.delete(id);
  }
  if (!setsEqual(closedLines.get(), eff)) closedLines.set(eff);
  const dark = new Set<string>();
  for (const [sid, served] of stationTopology) {
    if (served.every((id) => eff.has(id))) dark.add(sid);
  }
  if (!setsEqual(closedStations.get(), dark)) closedStations.set(dark);
}

/** Called by the poll with the raw closure set from the status API. */
export function publishPolledClosures(closed: ReadonlySet<string>): void {
  polledClosed = closed;
  republish();
}

/** Called once at mount with the station->lines map the network was built
 * from; closed-station derivation needs it. */
export function setStationTopology(
  map: ReadonlyMap<string, readonly string[]>,
): void {
  stationTopology = map;
  republish();
}

/** The line's debug override: true = forced closed, false = forced open,
 * null = live status. */
export function getLineOverride(lineId: string): boolean | null {
  return overrides.has(lineId) ? overrides.get(lineId)! : null;
}

/** Debug-panel cycle: live -> forced OPPOSITE of the polled status (the
 * first click always visibly flips the line) -> pinned AS the polled
 * status (immune to the next poll) -> back to live. */
export function cycleLineOverride(lineId: string): void {
  const cur = getLineOverride(lineId);
  const live = polledClosed.has(lineId);
  if (cur === null) overrides.set(lineId, !live);
  else if (cur === !live) overrides.set(lineId, live);
  else overrides.delete(lineId);
  lineOverridesRev.set(lineOverridesRev.get() + 1);
  republish();
}

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
 * closed network dims into the same family. `mix` overrides how far toward
 * the background to pull — text needs a gentler mix than geometry to stay
 * readable (see StationShapeUtil's label ink). */
export function dimmedColour(hex: string, mix: number = DIM_MIX): string {
  const key = `${hex}@${mix}`;
  const hit = dimCache.get(key);
  if (hit) return hit;
  const n = parseInt(hex.slice(1), 16);
  const grey = Math.min(
    // Luminance cap: the palest lines (Circle's yellow, Waterloo & City's
    // mint) would otherwise mix to within a few steps of the background
    // and effectively vanish — closed should read as "quiet", not "gone".
    160,
    0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255),
  );
  const toBg = (bg: number) => Math.round(grey + (bg - grey) * mix);
  const out = `#${((1 << 24) | (toBg(DIM_BG.r) << 16) | (toBg(DIM_BG.g) << 8) | toBg(DIM_BG.b)).toString(16).slice(1)}`;
  dimCache.set(key, out);
  return out;
}
