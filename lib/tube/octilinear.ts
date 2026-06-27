// Octilinear ("Beck-style") line routing for a FIXED-NODE transit map.
//
// Research lineage (stand on giants):
//  - Once station POSITIONS are fixed, the metro-map problem collapses from the
//    hard joint node-placement+routing optimisation (Nöllenburg & Wolff MIP;
//    Stott & Rodgers hill-climbing; Bast/Brosi/Storandt LOOM/Octi) into a much
//    simpler per-EDGE connector-routing problem: route an octilinear polyline
//    between two pinned endpoints. We solve that here.
//  - Each edge is a single-bend connector: a 45° diagonal plus an orthogonal
//    (H/V) segment — the classic schematic connector.
//  - Corners are rendered as quadratic Béziers whose control point is the bend
//    vertex, the rounded-corner technique from johnwalley/d3-tube-map.
//
// Everything is a PURE function of station positions, so it recomputes cheaply
// and reactively as stations are dragged, and generalises: auto-arranged or
// added/hidden stations and lines just change the inputs.

export interface Pt {
  x: number;
  y: number;
}

/** A line (or branch) as an ordered list of station ids + its colour. */
export interface OctiRouteInput {
  lineId: string;
  color: string;
  stationIds: string[];
}

/** A routed line: the octilinear polyline (stations + inserted bend points). */
export interface OctiRoute {
  lineId: string;
  color: string;
  points: Pt[];
}

const EPS = 1e-6;

function sign(n: number): number {
  return n > EPS ? 1 : n < -EPS ? -1 : 0;
}

/** Octilinear unit direction of a segment (each component in {-1,0,1}). */
function dirOf(a: Pt, b: Pt): [number, number] {
  return [sign(b.x - a.x), sign(b.y - a.y)];
}

/** Turn cost between two octilinear unit directions, in 45° steps (0…4). */
function turnCost(d1: [number, number], d2: [number, number]): number {
  if (d1[0] === 0 && d1[1] === 0) return 0;
  if (d2[0] === 0 && d2[1] === 0) return 0;
  let da = Math.abs(Math.atan2(d1[1], d1[0]) - Math.atan2(d2[1], d2[0]));
  if (da > Math.PI) da = 2 * Math.PI - da;
  return da / (Math.PI / 4);
}

interface Variant {
  points: Pt[];
  entry: [number, number];
  exit: [number, number];
  bends: number;
}

function makeVariant(points: Pt[]): Variant {
  return {
    points,
    entry: dirOf(points[0], points[1]),
    exit: dirOf(points[points.length - 2], points[points.length - 1]),
    bends: points.length - 2,
  };
}

/**
 * The octilinear connector(s) for one edge A→B. If A,B are already octilinearly
 * aligned (same x, same y, or on a 45° diagonal) it's a single straight
 * segment; otherwise there are two single-bend options — diagonal-first and
 * orthogonal-first — and the chain DP picks between them.
 */
function edgeVariants(a: Pt, b: Pt): Variant[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);

  // Already octilinear (vertical, horizontal, or exact diagonal) → straight.
  if (adx < EPS || ady < EPS || Math.abs(adx - ady) < EPS) {
    return [makeVariant([a, b])];
  }

  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  const s = Math.min(adx, ady); // length of the 45° diagonal leg

  let diagFirst: Pt;
  let orthoFirst: Pt;
  if (adx > ady) {
    // Horizontal-dominant: diagonal leg reaches B's row, then run horizontally.
    diagFirst = { x: a.x + sx * s, y: b.y };
    orthoFirst = { x: b.x - sx * s, y: a.y };
  } else {
    // Vertical-dominant: diagonal leg reaches B's column, then run vertically.
    diagFirst = { x: b.x, y: a.y + sy * s };
    orthoFirst = { x: a.x, y: b.y - sy * s };
  }

  return [makeVariant([a, diagFirst, b]), makeVariant([a, orthoFirst, b])];
}

/** Small penalty so straight edges are preferred when continuity ties. */
const BEND_PENALTY = 0.45;

/**
 * Route one line through its fixed station positions. Chooses each edge's bend
 * variant via a DP that minimises direction change at the stations (so the line
 * flows straight through where possible) plus a small bend penalty.
 */
function routeChain(positions: Pt[]): Pt[] {
  if (positions.length < 2) return positions.slice();

  const edges = positions.slice(0, -1).map((p, i) => edgeVariants(p, positions[i + 1]));

  // DP over edges. dp[i][v] = min cost of edge i using variant v.
  const dp: number[][] = [];
  const back: number[][] = [];
  edges.forEach((variants, i) => {
    dp[i] = [];
    back[i] = [];
    variants.forEach((variant, v) => {
      const own = variant.bends * BEND_PENALTY;
      if (i === 0) {
        dp[i][v] = own;
        back[i][v] = -1;
        return;
      }
      let best = Infinity;
      let bestPrev = 0;
      edges[i - 1].forEach((prev, pv) => {
        const cost = dp[i - 1][pv] + turnCost(prev.exit, variant.entry);
        if (cost < best) {
          best = cost;
          bestPrev = pv;
        }
      });
      dp[i][v] = best + own;
      back[i][v] = bestPrev;
    });
  });

  // Backtrack the cheapest final variant.
  const last = edges.length - 1;
  let chosen = dp[last].indexOf(Math.min(...dp[last]));
  const pickedVariants: Variant[] = [];
  for (let i = last; i >= 0; i--) {
    pickedVariants[i] = edges[i][chosen];
    chosen = back[i][chosen];
    if (chosen < 0 && i > 0) chosen = 0;
  }

  // Stitch the per-edge polylines, dropping the shared endpoint between edges.
  const out: Pt[] = [pickedVariants[0].points[0]];
  for (const variant of pickedVariants) {
    for (let k = 1; k < variant.points.length; k++) out.push(variant.points[k]);
  }
  return dedupe(out);
}

function dedupe(points: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.abs(last.x - p.x) > EPS || Math.abs(last.y - p.y) > EPS) {
      out.push(p);
    }
  }
  return out;
}

/** Route every line through its (looked-up) fixed station positions. */
export function routeOctilinear(
  positions: Map<string, Pt>,
  routes: OctiRouteInput[],
): OctiRoute[] {
  return routes.map((route) => {
    const pts: Pt[] = [];
    for (const id of route.stationIds) {
      const p = positions.get(id);
      if (p) pts.push(p);
    }
    return { lineId: route.lineId, color: route.color, points: routeChain(pts) };
  });
}

function len(a: Pt, b: Pt): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * SVG path for an octilinear polyline with Beck-style rounded corners: each
 * turn is a quadratic Bézier through the corner vertex, trimmed by `radius`
 * along both adjacent segments (clamped so short segments don't overshoot).
 */
export function octiPathD(points: Pt[], radius = 12): string {
  const pts = dedupe(points);
  if (pts.length < 2) return "";

  let d = `M${pts[0].x.toFixed(2)},${pts[0].y.toFixed(2)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1];
    const cur = pts[i];
    const next = pts[i + 1];
    const inDir = dirOf(prev, cur);
    const outDir = dirOf(cur, next);

    // Collinear → no corner, just continue straight.
    if (turnCost(inDir, outDir) < EPS) continue;

    const r = Math.min(radius, len(prev, cur) / 2, len(cur, next) / 2);
    const ui = unit(prev, cur);
    const uo = unit(cur, next);
    const p1 = { x: cur.x - ui.x * r, y: cur.y - ui.y * r };
    const p2 = { x: cur.x + uo.x * r, y: cur.y + uo.y * r };
    d += ` L${p1.x.toFixed(2)},${p1.y.toFixed(2)}`;
    d += ` Q${cur.x.toFixed(2)},${cur.y.toFixed(2)} ${p2.x.toFixed(2)},${p2.y.toFixed(2)}`;
  }
  const last = pts[pts.length - 1];
  d += ` L${last.x.toFixed(2)},${last.y.toFixed(2)}`;
  return d;
}

function unit(a: Pt, b: Pt): Pt {
  const l = len(a, b) || 1;
  return { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
}
