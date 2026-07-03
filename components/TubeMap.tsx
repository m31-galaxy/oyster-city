"use client";

import {
  type CSSProperties,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Tldraw, createShapeId, type Editor, type TLShapeId } from "tldraw";
import "tldraw/tldraw.css";
import {
  TubeLineShapeUtil,
  type TubeLineShape,
} from "@/components/shapes/TubeLineShapeUtil";
import {
  StationShapeUtil,
  type StationShape,
} from "@/components/shapes/StationShapeUtil";
import {
  TrainShapeUtil,
  type TrainShape,
} from "@/components/shapes/TrainShapeUtil";
import { getTubeNetwork } from "@/lib/tube/network";
import { selectStation } from "@/lib/tube/selection";
import {
  deriveTrains,
  makeBranch,
  stitchTrains,
  trainPose,
  trainTimeAt,
  type BranchInfo,
  type TrainPose,
  type TrainRecord,
} from "@/lib/tube/trains";
import type { Prediction } from "@/lib/tfl/types";

const shapeUtils = [TubeLineShapeUtil, StationShapeUtil, TrainShapeUtil];
const MARKER = 11;
const ANIM_MS = 650;
/** How often to refresh live train predictions (matches TfL's arrivals TTL). */
const TRAIN_POLL_MS = 30_000;
/** How often to reposition trains — trains crawl, so this stays smooth. */
const TRAIN_TICK_MS = 100;
/** Minimum window for easing away a poll correction (widened for big ones). */
const TRAIN_BLEND_MS = 1500;
/** Corrections implying more than this time shift jump instead of blending. */
const TRAIN_BLEND_MAX_MS = 90_000;
const TRAIN_W = 10;
const TRAIN_H = 6;

// Line ids to show — null shows the whole network.
const SHOWN_LINES: string[] | null = null;

type Pt = { x: number; y: number };
// Station layout position. Stations have no orientation (StationShapeUtil
// pins rotation to 0), so a pose is just a point.
type Pose = { x: number; y: number };
/**
 * A segment's OSM curve decomposed along/perpendicular to its geo chord, plus
 * each point's normalised arc-length (0..1) — the monotonic parameter that maps
 * curve points onto the octilinear connector during the morph.
 */
type SegProfile = { along: number[]; perp: number[]; arc: number[] };

const easeInOutCubic = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

/**
 * Smoothstep — used for the train-correction decay because its peak slope is
 * 1.5 (easeInOutCubic's is 3): with blendMs >= 2x the time offset this keeps
 * d(displayTime)/dt within [0.25, 1.75], so blended trains never move
 * backward (verified by the monotonicity unit check in the accuracy work).
 */
const smoothstepEase = (t: number) => t * t * (3 - 2 * t);

/** Build an SVG path + bounding box from page-space points (station centres).
 * Single-pass (no spreads/intermediate arrays) — this runs for every line on
 * every morph frame. */
function pathFromPoints(points: Pt[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  let d = "";
  for (let i = 0; i < points.length; i++) {
    d += `${i === 0 ? "M" : " L"} ${points[i].x - minX} ${points[i].y - minY}`;
  }
  return {
    x: minX,
    y: minY,
    w: maxX - minX || 1,
    h: maxY - minY || 1,
    d,
  };
}

/**
 * Current page-space centre of a station's MARKER, if the shape exists.
 * Computed from the page transform (cheaper than geometry bounds, and
 * independent of whatever extent the geometry covers).
 */
function stationCentre(editor: Editor, id: TLShapeId): Pt | null {
  const shape = editor.getShape(id) as StationShape | undefined;
  if (!shape) return null;
  const t = editor.getShapePageTransform(id);
  if (!t) return null;
  const p = t.applyToPoint({ x: shape.props.w / 2, y: shape.props.h / 2 });
  return { x: p.x, y: p.y };
}

/** Pixel tolerance below which a pair counts as already axis-aligned or 45°. */
const OCTI_EPS = 0.5;

/**
 * The single bend of a two-segment octilinear connector from `a` to `b`: a 45°
 * diagonal out of `a` that covers the shorter axis, then a straight run along
 * the longer axis into `b` (a 135° corner). Returns null when the pair is
 * already axis-aligned or a perfect 45° diagonal, where no bend is needed.
 */
function octiBend(a: Pt, b: Pt): Pt | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  if (adx < OCTI_EPS || ady < OCTI_EPS || Math.abs(adx - ady) < OCTI_EPS) {
    return null;
  }
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  return adx >= ady
    ? { x: a.x + sx * ady, y: b.y } // diagonal, then horizontal
    : { x: b.x, y: a.y + sy * adx }; // diagonal, then vertical
}

/** Corner-fillet radius for octilinear bends (page px). Every bend is a 45°
 * turn by construction; rounding it with a circular arc lets lines — and the
 * trains riding them — sweep through corners instead of snapping direction. */
const OCTI_FILLET_R = 18;
/** Polyline samples across the fillet arc (endpoints inclusive). */
const OCTI_ARC_POINTS = 7;

/**
 * An octilinear connector a->b with its 45° bend rounded by a circular
 * fillet, arc-length parameterized over [leg1, arc, leg2]. Null when the pair
 * is axis-aligned or a perfect diagonal (no bend — a straight line).
 */
interface OctiConn {
  a: Pt;
  /** Unit vectors of the two legs. */
  u1: Pt;
  u2: Pt;
  /** Fillet endpoints on leg 1 / leg 2. */
  t1: Pt;
  t2: Pt;
  /** Arc centre. */
  cx: number;
  cy: number;
  /** Signed sweep angle (rad) — sign is the turn direction. */
  sweep: number;
  /** Lengths: leg 1 up to the fillet, the arc, and the grand total. */
  L1: number;
  LA: number;
  total: number;
}

function octiConnector(a: Pt, b: Pt): OctiConn | null {
  const bend = octiBend(a, b);
  if (!bend) return null;
  const l1 = Math.hypot(bend.x - a.x, bend.y - a.y);
  const l2 = Math.hypot(b.x - bend.x, b.y - bend.y);
  const u1 = { x: (bend.x - a.x) / l1, y: (bend.y - a.y) / l1 };
  const u2 = { x: (b.x - bend.x) / l2, y: (b.y - bend.y) / l2 };
  const cross = u1.x * u2.y - u1.y * u2.x;
  const dot = u1.x * u2.x + u1.y * u2.y;
  const phi = Math.abs(Math.atan2(cross, dot)); // 45° by construction
  const side = cross >= 0 ? 1 : -1;
  const tanHalf = Math.tan(phi / 2);
  // Tangent offset from the corner; the fillet never eats more than 40% of
  // either leg (short segments degrade gracefully toward a sharp corner).
  const d = Math.min(OCTI_FILLET_R * tanHalf, 0.4 * Math.min(l1, l2));
  const r = d / tanHalf;
  const t1 = { x: bend.x - u1.x * d, y: bend.y - u1.y * d };
  const t2 = { x: bend.x + u2.x * d, y: bend.y + u2.y * d };
  // Arc centre: from t1 along leg-1's normal, toward the turn side.
  const cx = t1.x - u1.y * side * r;
  const cy = t1.y + u1.x * side * r;
  const L1 = l1 - d;
  const LA = r * phi;
  return {
    a,
    u1,
    u2,
    t1,
    t2,
    cx,
    cy,
    sweep: side * phi,
    L1,
    LA,
    total: L1 + LA + (l2 - d),
  };
}

/** Point + tangent at arc-length fraction `f` along a rounded connector. */
function octiConnPointAt(c: OctiConn, f: number): { point: Pt; tangent: Pt } {
  const t = (f < 0 ? 0 : f > 1 ? 1 : f) * c.total;
  if (t <= c.L1) {
    return {
      point: { x: c.a.x + c.u1.x * t, y: c.a.y + c.u1.y * t },
      tangent: { x: c.u1.x, y: c.u1.y },
    };
  }
  if (t >= c.L1 + c.LA) {
    const d2 = t - c.L1 - c.LA;
    return {
      point: { x: c.t2.x + c.u2.x * d2, y: c.t2.y + c.u2.y * d2 },
      tangent: { x: c.u2.x, y: c.u2.y },
    };
  }
  const ang = c.LA > 1e-9 ? ((t - c.L1) / c.LA) * c.sweep : 0;
  const cos = Math.cos(ang);
  const sin = Math.sin(ang);
  const vx = c.t1.x - c.cx;
  const vy = c.t1.y - c.cy;
  return {
    point: { x: c.cx + vx * cos - vy * sin, y: c.cy + vx * sin + vy * cos },
    tangent: {
      x: c.u1.x * cos - c.u1.y * sin,
      y: c.u1.x * sin + c.u1.y * cos,
    },
  };
}

/** The fillet arc sampled as polyline points (t1..t2 inclusive). */
function octiConnArcPoints(c: OctiConn): Pt[] {
  const out: Pt[] = [];
  const vx = c.t1.x - c.cx;
  const vy = c.t1.y - c.cy;
  for (let i = 0; i < OCTI_ARC_POINTS; i++) {
    const ang = (i / (OCTI_ARC_POINTS - 1)) * c.sweep;
    const cos = Math.cos(ang);
    const sin = Math.sin(ang);
    out.push({ x: c.cx + vx * cos - vy * sin, y: c.cy + vx * sin + vy * cos });
  }
  return out;
}

/** Octilinear polyline through `centres` — a rounded 45° bend per pair. */
function octilinearPoints(centres: Pt[]): Pt[] {
  if (centres.length < 2) return centres.slice();
  const out: Pt[] = [centres[0]];
  for (let i = 1; i < centres.length; i++) {
    const conn = octiConnector(centres[i - 1], centres[i]);
    if (conn) for (const p of octiConnArcPoints(conn)) out.push(p);
    out.push(centres[i]);
  }
  return out;
}

/**
 * One station-pair segment of a morphing line, blended between its octilinear
 * editable shape (`morphFrac` 0) and its geographic curve (`morphFrac` 1).
 *
 * Each output point is the lerp of a point on the octilinear connector and the
 * matching point on the curve (`profile`, the precomputed along/perp of the OSM
 * track) — or the straight chord when the pair has no geometry — both taken at
 * the same fraction along the live chord cA->cB. The shared endpoints stay
 * pinned to cA/cB (so the stations never detach) and the bend vertex is sampled
 * exactly, so morphFrac 0/1 reproduce the two rest states with no snap.
 */
function morphSegmentPoints(
  cA: Pt,
  cB: Pt,
  profile: SegProfile | null,
  morphFrac: number,
): Pt[] {
  const cx = cB.x - cA.x;
  const cy = cB.y - cA.y;
  const lenSq = cx * cx + cy * cy;
  const L = Math.sqrt(lenSq) || 1;
  const pux = -cy / L; // unit perpendicular of the chord
  const puy = cx / L;
  const conn = octiConnector(cA, cB);
  // The (rounded) octilinear connector at arc-length fraction a (0..1).
  const octiAt = (a: number): Pt =>
    conn
      ? octiConnPointAt(conn, a).point
      : { x: cA.x + a * cx, y: cA.y + a * cy };
  // The curve (or straight chord) point at chord-fraction s, perp offset pf.
  const curveAt = (s: number, pf: number): Pt => ({
    x: cA.x + s * cx + pf * L * pux,
    y: cA.y + s * cy + pf * L * puy,
  });
  const mix = (o: Pt, c: Pt): Pt => ({
    x: o.x + (c.x - o.x) * morphFrac,
    y: o.y + (c.y - o.y) * morphFrac,
  });
  const along = profile ? profile.along : [0, 1];
  const perp = profile ? profile.perp : [0, 0];
  const arc = profile ? profile.arc : [0, 1];
  // Inject the fillet arc's samples at their arc fractions: the rounded
  // corner is drawn exactly at morphFrac 0 and the injected points sit on the
  // curve (collinear, invisible) at morphFrac 1. Fractions are strictly
  // inside (0, 1), so each lands between two profile points.
  const inj = conn
    ? octiConnArcPoints(conn).map((p, i) => ({
        f: (conn.L1 + (i / (OCTI_ARC_POINTS - 1)) * conn.LA) / conn.total,
        p,
      }))
    : [];
  let nextInj = 0;
  const out: Pt[] = [];
  for (let j = 0; j < along.length; j++) {
    while (nextInj < inj.length && inj[nextInj].f < arc[j]) {
      const prev = arc[j - 1];
      const f = (inj[nextInj].f - prev) / (arc[j] - prev || 1);
      const alongI = along[j - 1] + (along[j] - along[j - 1]) * f;
      const perpI = perp[j - 1] + (perp[j] - perp[j - 1]) * f;
      out.push(mix(inj[nextInj].p, curveAt(alongI, perpI)));
      nextInj++;
    }
    // Octilinear point by monotonic arc-length; curve point by chord (along,perp).
    out.push(mix(octiAt(arc[j]), curveAt(along[j], perp[j])));
  }
  return out;
}

/**
 * Point + tangent at parameter `a` (0..1, the profile's arc parameter) along
 * the morphing pair cA->cB — the single-point equivalent of
 * `pointAlong(morphSegmentPoints(...), a)` without building the polyline.
 *
 * Evaluates the same octilinear/curve blend at one parameter, so the result
 * always lies exactly ON the drawn blended polyline and coincides with the
 * settle-state evaluators at morphFrac 0 (octiPointAt) and 1 (pointAlongArc);
 * mid-tween the parameterization differs from true polyline arc length by a
 * sub-pixel amount along the line. O(log n), no allocation — this keeps the
 * per-frame train pass cheap during the morph (600+ trains at 60fps).
 */
function morphPointAt(
  cA: Pt,
  cB: Pt,
  profile: SegProfile | null,
  morphFrac: number,
  a: number,
): { point: Pt; tangent: Pt } {
  const cx = cB.x - cA.x;
  const cy = cB.y - cA.y;
  const L = Math.hypot(cx, cy) || 1;
  const pux = -cy / L;
  const puy = cx / L;
  const conn = octiConnector(cA, cB);
  const along = profile ? profile.along : null;
  const perp = profile ? profile.perp : null;
  const arc = profile ? profile.arc : null;
  const n = along ? along.length : 2;
  const xy = (t: number): Pt => {
    // Octilinear component (arc-length parameterized, rounded at the bend).
    let ox: number;
    let oy: number;
    if (!conn) {
      ox = cA.x + t * cx;
      oy = cA.y + t * cy;
    } else {
      const p = octiConnPointAt(conn, t).point;
      ox = p.x;
      oy = p.y;
    }
    // Curve component: lerp the profile's (along, perp) at arc parameter t.
    let s: number;
    let pf: number;
    if (!along || !perp || !arc) {
      s = t;
      pf = 0;
    } else {
      let lo = 0;
      let hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (arc[mid + 1] < t) lo = mid + 1;
        else hi = mid;
      }
      const k = Math.min(lo, n - 2);
      const span = arc[k + 1] - arc[k];
      const u = span > 0 ? (t - arc[k]) / span : 0;
      s = along[k] + (along[k + 1] - along[k]) * u;
      pf = perp[k] + (perp[k + 1] - perp[k]) * u;
    }
    const gx = cA.x + s * cx + pf * L * pux;
    const gy = cA.y + s * cy + pf * L * puy;
    return { x: ox + (gx - ox) * morphFrac, y: oy + (gy - oy) * morphFrac };
  };
  const t = a < 0 ? 0 : a > 1 ? 1 : a;
  const point = xy(t);
  const EPS = 1e-3;
  const back = xy(t < EPS ? 0 : t - EPS);
  const fwd = xy(t > 1 - EPS ? 1 : t + EPS);
  return { point, tangent: { x: fwd.x - back.x, y: fwd.y - back.y } };
}

/** Decompose each per-pair segment into a SegProfile (along/perp/arc). */
function buildSegProfiles(segs: (Pt[] | null)[]): (SegProfile | null)[] {
  return segs.map((seg) => {
    if (!seg || seg.length < 2) return null;
    const a = seg[0];
    const b = seg[seg.length - 1];
    const cx = b.x - a.x;
    const cy = b.y - a.y;
    const L = Math.hypot(cx, cy) || 1;
    const ux = cx / L;
    const uy = cy / L;
    const along: number[] = [];
    const perp: number[] = [];
    const arc: number[] = [];
    let cum = 0;
    for (let k = 0; k < seg.length; k++) {
      const p = seg[k];
      const dx = p.x - a.x;
      const dy = p.y - a.y;
      along.push((dx * ux + dy * uy) / L);
      perp.push((dx * -uy + dy * ux) / L);
      if (k > 0) cum += Math.hypot(p.x - seg[k - 1].x, p.y - seg[k - 1].y);
      arc.push(cum);
    }
    const total = cum || 1;
    for (let k = 0; k < arc.length; k++) arc[k] /= total;
    return { along, perp, arc };
  });
}

/** Point + forward tangent at arc-length fraction `f` along a page-space polyline. */
function pointAlong(pts: Pt[], f: number): { point: Pt; tangent: Pt } {
  const n = pts.length;
  if (n === 0) return { point: { x: 0, y: 0 }, tangent: { x: 1, y: 0 } };
  if (n === 1) return { point: pts[0], tangent: { x: 1, y: 0 } };
  const seg: number[] = [];
  let total = 0;
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    seg.push(d);
    total += d;
  }
  const target = (f < 0 ? 0 : f > 1 ? 1 : f) * total;
  let acc = 0;
  let k = 0;
  while (k < n - 2 && acc + seg[k] < target) acc += seg[k++];
  const local = seg[k] > 0 ? (target - acc) / seg[k] : 0;
  return {
    point: {
      x: pts[k].x + (pts[k + 1].x - pts[k].x) * local,
      y: pts[k].y + (pts[k + 1].y - pts[k].y) * local,
    },
    tangent: { x: pts[k + 1].x - pts[k].x, y: pts[k + 1].y - pts[k].y },
  };
}

/**
 * Like {@link pointAlong} but with a precomputed normalised cumulative arc
 * (0..1, one per point) — an O(log n) lookup with no per-call arc-length sweep,
 * for the hot geo-mode path where the curve (and its arc table) is immutable.
 */
function pointAlongArc(
  pts: Pt[],
  arc: number[],
  f: number,
): { point: Pt; tangent: Pt } {
  const n = pts.length;
  if (n < 2)
    return { point: pts[0] ?? { x: 0, y: 0 }, tangent: { x: 1, y: 0 } };
  const t = f < 0 ? 0 : f > 1 ? 1 : f;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arc[mid + 1] < t) lo = mid + 1;
    else hi = mid;
  }
  const k = Math.min(lo, n - 2);
  const span = arc[k + 1] - arc[k];
  const local = span > 0 ? (t - arc[k]) / span : 0;
  return {
    point: {
      x: pts[k].x + (pts[k + 1].x - pts[k].x) * local,
      y: pts[k].y + (pts[k + 1].y - pts[k].y) * local,
    },
    tangent: { x: pts[k + 1].x - pts[k].x, y: pts[k + 1].y - pts[k].y },
  };
}

/** Point + tangent at fraction `f` along the (rounded) octilinear connector
 * cA->cB — trains sweep smoothly through the fillet, tangent included. */
function octiPointAt(cA: Pt, cB: Pt, f: number): { point: Pt; tangent: Pt } {
  const conn = octiConnector(cA, cB);
  if (!conn) {
    return {
      point: { x: cA.x + f * (cB.x - cA.x), y: cA.y + f * (cB.y - cA.y) },
      tangent: { x: cB.x - cA.x, y: cB.y - cA.y },
    };
  }
  return octiConnPointAt(conn, f);
}

/** Point + tangent at fraction `f` along the straight chord cA->cB. */
function straightAt(cA: Pt, cB: Pt, f: number): { point: Pt; tangent: Pt } {
  return {
    point: { x: cA.x + f * (cB.x - cA.x), y: cA.y + f * (cB.y - cA.y) },
    tangent: { x: cB.x - cA.x, y: cB.y - cA.y },
  };
}

/**
 * Redraw one line. With `curve` (the projected OSM track) it follows the real
 * geography; otherwise it draws through its stations' current centres — bent
 * octilinearly when `octi` (the editable layout), or straight.
 */
function recomputeLine(
  editor: Editor,
  line: TubeLineShape,
  curve: Pt[] | null,
  octi: boolean,
) {
  let pts: Pt[];
  if (curve && curve.length >= 2) {
    pts = curve;
  } else {
    const centres = (line.props.stationIds as TLShapeId[])
      .map((id) => stationCentre(editor, id))
      .filter((c): c is Pt => !!c);
    pts = octi ? octilinearPoints(centres) : centres;
  }
  if (pts.length < 2) return;
  const path = pathFromPoints(pts);
  editor.updateShape<TubeLineShape>({
    id: line.id,
    type: "tube-line",
    x: path.x,
    y: path.y,
    props: { w: path.w, h: path.h, d: path.d },
  });
}

/**
 * Redraw every line. Pass `lineGeo` to draw OSM curves where available; lines
 * without a curve fall back to `octi` octilinear (editable) or straight chords.
 */
function recomputeAllLines(
  editor: Editor,
  lineGeo: Map<TLShapeId, Pt[]> | null,
  octi: boolean,
) {
  editor.run(
    () => {
      for (const shape of editor.getCurrentPageShapes()) {
        if (shape.type === "tube-line") {
          recomputeLine(editor, shape, lineGeo?.get(shape.id) ?? null, octi);
        }
      }
    },
    { ignoreShapeLock: true },
  );
}

/**
 * Editable schematic Tube-map canvas (the `'use client'` island).
 *
 * Stations are draggable nodes; lines are locked decoration that follow them.
 * A geo/editable toggle animates every station between its geographically
 * accurate position and the user's custom (dragged) layout.
 */
export default function TubeMap() {
  const [mounted, setMounted] = useState(false);
  const [geoMode, setGeoMode] = useState(false);

  const editorRef = useRef<Editor | null>(null);
  const geoPos = useRef<Map<TLShapeId, Pose>>(new Map());
  const customPos = useRef<Map<TLShapeId, Pose>>(new Map());
  const lineGeo = useRef<Map<TLShapeId, Pt[]>>(new Map());
  const lineSegGeo = useRef<Map<TLShapeId, (Pt[] | null)[]>>(new Map());
  const animating = useRef(false);
  const animFrame = useRef<number | null>(null);

  // Live-train state (populated in handleMount, driven by the poll + rAF loops).
  const shapeIdForRef = useRef<Map<string, TLShapeId>>(new Map());
  const branchesForLineRef = useRef<Map<string, BranchInfo[]>>(new Map());
  const branchStationIdsRef = useRef<Map<string, string[]>>(new Map());
  const segProfilesRef = useRef<Map<TLShapeId, (SegProfile | null)[]>>(
    new Map(),
  );
  const naptanToHubRef = useRef<Record<string, string>>({});
  const stationPosRef = useRef<Map<string, [number, number]>>(new Map());
  const lineColorRef = useRef<Map<string, string>>(new Map());
  const trainStore = useRef<Map<string, TrainRecord>>(new Map());
  const trainShapes = useRef<Map<string, TLShapeId>>(new Map());
  // Per-train render state for easing away the position correction each poll.
  // Preferred: a TIME offset (the train runs briefly slow/fast, never visibly
  // backward); fallback: a 2D point offset when the new trajectory doesn't
  // pass through the displayed pose (branch switch, reroute).
  const trainRender = useRef<
    Map<
      string,
      {
        x: number;
        y: number;
        fetchMs: number;
        pose: TrainPose | null;
        timeOff: number;
        offX: number;
        offY: number;
        offStart: number;
        blendMs: number;
      }
    >
  >(new Map());
  /** 0 = editable, 1 = geographic, in between while the morph tween runs. */
  const morphFracRef = useRef(0);

  useEffect(() => setMounted(true), []);

  const handleMount = useCallback((editor: Editor) => {
    if (process.env.NODE_ENV !== "production") {
      (window as unknown as { editor?: Editor }).editor = editor;
    }

    // Build once per editor (guards React strict-mode double-invoke).
    const ed = editor as Editor & { __oysterBuilt?: boolean };
    if (ed.__oysterBuilt) return;
    ed.__oysterBuilt = true;

    const net = getTubeNetwork();
    naptanToHubRef.current = net.naptanToHub;
    stationPosRef.current = new Map(
      net.stations.map((s) => [s.id, [s.lon, s.lat]]),
    );
    const lines = SHOWN_LINES
      ? net.lines.filter((l) => SHOWN_LINES.includes(l.id))
      : net.lines;

    const lineCount = new Map<string, number>();
    const colourFor = new Map<string, string>();
    for (const line of lines) {
      for (const sid of line.stationIds) {
        lineCount.set(sid, (lineCount.get(sid) ?? 0) + 1);
        if (!colourFor.has(sid)) colourFor.set(sid, line.color);
      }
    }
    const stations = net.stations.filter((s) => lineCount.has(s.id));
    const centreFor = new Map<string, Pt>(
      stations.map((s) => [s.id, { x: s.cx, y: s.cy }]),
    );
    const shapeIdFor = new Map<string, TLShapeId>(
      stations.map((s) => [s.id, createShapeId()]),
    );
    shapeIdForRef.current = shapeIdFor;

    const stationShapes = stations.map((s) => {
      const id = shapeIdFor.get(s.id)!;
      const pos = { x: s.cx - MARKER / 2, y: s.cy - MARKER / 2 };
      // Both layouts start at the geographic position.
      geoPos.current.set(id, { ...pos });
      customPos.current.set(id, { ...pos });
      return {
        id,
        type: "station" as const,
        x: pos.x,
        y: pos.y,
        props: {
          w: MARKER,
          h: MARKER,
          name: s.name,
          stationId: s.id,
          interchange: (lineCount.get(s.id) ?? 0) > 1,
          labelPos: s.labelPos,
          color: colourFor.get(s.id) ?? s.color,
        },
      };
    });

    const lineShapes = lines.map((line) => {
      const lineId = createShapeId();
      const ids = line.stationIds
        .map((sid) => shapeIdFor.get(sid))
        .filter((id): id is TLShapeId => !!id);
      const centres = line.stationIds
        .map((sid) => centreFor.get(sid))
        .filter((c): c is Pt => !!c);
      // Mount starts in editable mode → octilinear connectors.
      const path = pathFromPoints(octilinearPoints(centres));
      // Stash the projected OSM track curve (settle) + per-pair segments (morph).
      if (line.geoPoints.length >= 2) {
        lineGeo.current.set(
          lineId,
          line.geoPoints.map(([x, y]) => ({ x, y })),
        );
      }
      // Gate both maps on the same alignment check: the geo train path reads
      // lineSegGeo by pair index and the morph path reads segProfilesRef, so a
      // count mismatch must disable both together (else they'd draw different
      // geometry). All current lines satisfy this; warn if a rebuild breaks it.
      if (line.geoSegments.length === line.stationIds.length - 1) {
        const segs = line.geoSegments.map((seg) =>
          seg ? seg.map(([x, y]) => ({ x, y })) : null,
        );
        lineSegGeo.current.set(lineId, segs);
        segProfilesRef.current.set(lineId, buildSegProfiles(segs));
      } else if (
        line.geoSegments.length &&
        process.env.NODE_ENV !== "production"
      ) {
        console.warn(
          `[tube] ${line.id}: geoSegments ${line.geoSegments.length} != stationIds-1 ${line.stationIds.length - 1}; ignoring geometry`,
        );
      }
      // Register this branch so live trains can resolve onto its segments.
      branchStationIdsRef.current.set(lineId, line.stationIds);
      const branches = branchesForLineRef.current.get(line.id);
      const branch = makeBranch(lineId, line.stationIds);
      if (branches) branches.push(branch);
      else branchesForLineRef.current.set(line.id, [branch]);
      lineColorRef.current.set(line.id, line.color);
      return {
        id: lineId,
        type: "tube-line" as const,
        x: path.x,
        y: path.y,
        isLocked: true,
        props: {
          w: path.w,
          h: path.h,
          color: line.color,
          d: path.d,
          stationIds: ids,
        },
      };
    });

    editor.createShapes<TubeLineShape | StationShape>([
      ...lineShapes,
      ...stationShapes,
    ]);

    // Selection-gesture modifiers: rotation snaps to 45° increments by
    // default and resizing keeps the aspect ratio by default; holding Shift
    // inverts either (freeform rotate / free-stretch resize). tldraw
    // hard-codes the opposite convention (shift = snap to 15° / lock aspect)
    // with no public hook, so two narrow patches:
    //  - the select tool's Rotating state gets its angle computation replaced
    //    (same contract as the original — see Rotating.ts — minus its 15°
    //    shift-snap, plus a 45° default snap);
    //  - inputs.getShiftKey() reports inverted while the resize session is
    //    active, feeding its `shiftKey || !canShapesDeform` aspect-lock. The
    //    only other getShiftKey consumer during a resize is the shift-release
    //    grace-timeout in Editor.dispatch, where a stale read is harmless.
    const rotating = editor.getStateDescendant("select.rotating") as unknown as
      | {
          snapshot: {
            initialCursorAngle: number;
            initialShapesRotation: number;
            initialPageCenter: { angle(p: unknown): number };
          };
          _getRotationFromPointerPosition(opts: {
            snapToNearestDegree: boolean;
          }): number;
        }
      | undefined;
    if (rotating) {
      const SEG = Math.PI / 4;
      rotating._getRotationFromPointerPosition = function () {
        const { initialCursorAngle, initialShapesRotation, initialPageCenter } =
          this.snapshot;
        const delta =
          initialPageCenter.angle(editor.inputs.getCurrentPagePoint()) -
          initialCursorAngle;
        let rot = initialShapesRotation + delta;
        if (!editor.inputs.getShiftKey()) rot = Math.round(rot / SEG) * SEG;
        return rot - initialShapesRotation;
      };
    }
    const inputs = editor.inputs as unknown as { getShiftKey(): boolean };
    const realGetShiftKey = inputs.getShiftKey.bind(editor.inputs);
    inputs.getShiftKey = () =>
      editor.isIn("select.resizing") ? !realGetShiftKey() : realGetShiftKey();

    // Reactive lines: when a station is dragged, redraw the lines through it —
    // and re-pose the trains on those lines in the SAME batch, so they stay
    // glued to the moving geometry instead of catching up at the ambient tick.
    // Skipped while animating — the tween redraws lines (and trains) itself.
    editor.sideEffects.registerAfterChangeHandler("shape", (prev, next) => {
      if (animating.current) return;
      if (next.type !== "station") return;
      if (prev.x === next.x && prev.y === next.y) return;
      editor.run(
        () => {
          const affected = new Set<string>();
          for (const shape of editor.getCurrentPageShapes()) {
            if (shape.type !== "tube-line") continue;
            const ids = shape.props.stationIds as TLShapeId[];
            // Dragging only happens in editable mode → octilinear connectors.
            if (ids.includes(next.id)) {
              recomputeLine(editor, shape, null, true);
              affected.add(shape.id);
            }
          }
          if (affected.size) positionTrains(affected);
        },
        { ignoreShapeLock: true },
      );
    });

    // Selecting a station drives the sidebar readout.
    editor.sideEffects.registerAfterChangeHandler("instance_page_state", () => {
      const sel = editor.getOnlySelectedShape();
      selectStation(
        sel && sel.type === "station"
          ? { id: sel.props.stationId, name: sel.props.name }
          : null,
      );
    });

    const fit = () => {
      const vp = editor.getViewportScreenBounds();
      if (!vp || vp.w < 1 || vp.h < 1) {
        requestAnimationFrame(fit);
        return;
      }
      editor.zoomToFit();
    };
    requestAnimationFrame(fit);

    editorRef.current = editor;
  }, []);

  // Animate stations to the target layout (and follow with the lines).
  const applyMode = useCallback((editor: Editor, geo: boolean) => {
    if (animFrame.current !== null) cancelAnimationFrame(animFrame.current);

    // Allow programmatic moves while animating; lock to view-only in geo mode.
    editor.updateInstanceState({ isReadonly: false });

    const ids = [...geoPos.current.keys()];
    const starts = new Map<TLShapeId, Pose>(
      ids.map((id) => {
        const s = editor.getShape(id);
        return [id, { x: s?.x ?? 0, y: s?.y ?? 0 }];
      }),
    );
    // Leaving editable mode: remember the user's custom layout first.
    if (geo) for (const [id, p] of starts) customPos.current.set(id, p);
    const targets = geo ? geoPos.current : customPos.current;

    // Each line's per-pair SegProfiles (along/perp/arc) are precomputed once at
    // mount (segProfilesRef); the tween re-anchors them to the current chord
    // between the two live stations, keeping stations on the line.
    const lineMorph = editor
      .getCurrentPageShapes()
      .filter((s): s is TubeLineShape => s.type === "tube-line")
      .map((s) => ({
        id: s.id,
        stationIds: s.props.stationIds as TLShapeId[],
        segMorph: segProfilesRef.current.get(s.id) ?? [],
      }));

    // Only animate stations that actually move (none, in the common no-edit
    // case) — keeps the whole-network tween cheap.
    const movingIds = ids.filter((id) => {
      const s = starts.get(id)!;
      const g = targets.get(id)!;
      return Math.abs(s.x - g.x) > 0.5 || Math.abs(s.y - g.y) > 0.5;
    });

    animating.current = true;
    let startTs: number | null = null;

    const tick = (now: number) => {
      if (startTs === null) startTs = now;
      const t = Math.min(1, (now - startTs) / ANIM_MS);
      const e = easeInOutCubic(t);
      editor.run(
        () => {
          for (const id of movingIds) {
            const s = starts.get(id)!;
            const g = targets.get(id)!;
            editor.updateShape({
              id,
              type: "station",
              x: s.x + (g.x - s.x) * e,
              y: s.y + (g.y - s.y) * e,
            });
          }
          // Draw each line by blending every station-pair segment between its
          // octilinear editable shape (morphFrac 0) and its OSM curve
          // (morphFrac 1), anchored to the two CURRENT station centres. Because
          // every segment's endpoints sit exactly on a station centre, the
          // stations never detach from the line during the tween.
          const morphFrac = geo ? e : 1 - e;
          morphFracRef.current = morphFrac; // trains follow the same blend
          for (const lm of lineMorph) {
            const centres = lm.stationIds
              .map((id) => stationCentre(editor, id))
              .filter((c): c is Pt => !!c);
            if (centres.length < 2) continue;
            let pts: Pt[];
            if (centres.length === lm.stationIds.length) {
              pts = [];
              for (let i = 0; i < centres.length - 1; i++) {
                const segPts = morphSegmentPoints(
                  centres[i],
                  centres[i + 1],
                  lm.segMorph[i] ?? null,
                  morphFrac,
                );
                for (let k = 0; k < segPts.length; k++) {
                  // Drop each segment's first point — it is the previous
                  // segment's shared station endpoint.
                  if (i > 0 && k === 0) continue;
                  pts.push(segPts[k]);
                }
              }
            } else {
              // Some stations missing → octilinear through what we have.
              pts = octilinearPoints(centres);
            }
            const path = pathFromPoints(pts);
            editor.updateShape<TubeLineShape>({
              id: lm.id,
              type: "tube-line",
              x: path.x,
              y: path.y,
              props: { w: path.w, h: path.h, d: path.d },
            });
          }
        },
        { ignoreShapeLock: true },
      );
      // Re-pose all trains on the freshly drawn morph frame — the ambient
      // ~10fps tick would let them visibly lag the 60fps line tween.
      positionTrains();
      if (t < 1) {
        animFrame.current = requestAnimationFrame(tick);
      } else {
        animFrame.current = null;
        animating.current = false;
        morphFracRef.current = geo ? 1 : 0;
        // Settle: geographic snaps lines onto the real OSM track curves;
        // editable settles onto octilinear connectors.
        recomputeAllLines(editor, geo ? lineGeo.current : null, !geo);
        editor.updateInstanceState({ isReadonly: geo });
        positionTrains();
      }
    };
    animFrame.current = requestAnimationFrame(tick);
  }, []);

  // Animate only on a real mode change — skip the initial mount (and React
  // strict-mode's double-invoke), which would otherwise run a no-op animation.
  const lastMode = useRef(false);
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || lastMode.current === geoMode) return;
    lastMode.current = geoMode;
    applyMode(editor, geoMode);
  }, [geoMode, applyMode]);

  // Reposition every live train onto its current segment, matching how the line
  // is drawn: the geo curve, the octilinear connector, or the live morph blend.
  //
  // `onlyBranches` limits the pass to trains on those tube-line shapes — used
  // by the station-drag side effect and the mode-morph tick to move trains in
  // the SAME synchronous batch that redraws the lines (otherwise trains lag
  // the line at the ambient ~10fps tick and look detached). A filtered pass
  // only updates existing shapes: create/delete must see every key, so they
  // stay with the full ambient pass.
  //
  // `fine` marks the per-frame smoothing pass: visible trains only (via their
  // last rendered point), near-zero update gates so motion advances every
  // frame in sub-pixel steps instead of ~0.5-screen-px hops at 10Hz. It
  // skips create/delete and rs initialisation (the 10Hz full pass owns
  // those), and bails entirely when zoomed out far enough that full-pass
  // steps are already sub-pixel.
  const positionTrains = useCallback(
    (onlyBranches?: ReadonlySet<string>, fine = false) => {
      const editor = editorRef.current;
      if (!editor) return;
      if (fine && editor.getZoomLevel() < 0.5) return;
      const store = trainStore.current;
      const shapes = trainShapes.current;
      const render = trainRender.current;
      if (store.size === 0 && shapes.size === 0) return;
      const now = performance.now();
      const nowEpoch = Date.now();
      const morphFrac = morphFracRef.current;
      const geo = morphFrac >= 1 - 1e-6;
      const octi = morphFrac <= 1e-6;
      const settled = geo || octi;
      // Perceptual gating: skip shape updates smaller than half a SCREEN pixel
      // (zoomed out, every train moves sub-pixel per frame), and skip trains
      // that are off-screen before AND after the move — positions are absolute,
      // so they're exact whenever they re-enter view. Both cut the per-frame
      // update count during the morph without any visible difference. The fine
      // per-frame pass instead uses near-zero gates: visible motion advances
      // every frame in sub-pixel increments — that's the butter.
      const zoom = editor.getZoomLevel();
      // Fine gate: ~0.08 screen px — far below perception at 60fps, but ~3x
      // fewer store writes than updating every moving train every frame.
      const minDelta = fine ? 0.08 / zoom : Math.max(0.2, 0.5 / zoom);
      const minRot = fine ? 0.004 : 0.02;
      const vp = editor.getViewportPageBounds();
      const vpX0 = vp.x - 50;
      const vpY0 = vp.y - 50;
      const vpX1 = vp.x + vp.w + 50;
      const vpY1 = vp.y + vp.h + 50;
      const onScreen = (px: number, py: number) =>
        px >= vpX0 && px <= vpX1 && py >= vpY0 && py <= vpY1;

      // Read-only pass first: compute poses and collect the create/update/delete
      // work. Store writes (and geo mode's readonly lift) happen only when there
      // IS work — most ambient ticks are no-ops thanks to the perceptual gate,
      // and a no-op tick that toggled instance state 10x/s caused store churn
      // during panning for nothing.
      const seen = new Set<string>();
      const toCreate: {
        id: TLShapeId;
        type: "train";
        x: number;
        y: number;
        rotation: number;
        isLocked: boolean;
        props: { w: number; h: number; color: string };
      }[] = [];
      // One batched updateShapes call; heading goes in the shape's TOP-LEVEL
      // rotation (props stay constant), so tldraw's memoized component never
      // re-renders — per-frame React re-renders of 600+ trains were the
      // mode-morph's dominant cost. Rotation pivots the top-left corner, so
      // x/y are counter-offset to keep the marker CENTRE on the track point.
      const toUpdate: {
        id: TLShapeId;
        type: "train";
        x: number;
        y: number;
        rotation: number;
      }[] = [];
      for (const [key, rec] of store) {
        // On a fresh poll, convert the correction into a TIME offset that
        // decays to zero: the train briefly runs slow (or pauses / gently
        // catches up) instead of teleporting or sliding backward. The blend
        // window widens with the offset so display speed stays within
        // 0.25x-1.75x of real. Falls back to a decaying 2D point offset when
        // the new trajectory doesn't pass the displayed pose (reroute /
        // branch switch). Skipped during the morph, where the whole line is
        // already moving.
        let rs = render.get(key);
        // Fine passes smooth what's already on screen; initialisation and
        // newly-visible trains belong to the 10Hz full pass.
        if (fine && (!rs || !onScreen(rs.x, rs.y))) continue;
        let capture2D = false;
        if (rs && rs.fetchMs !== rec.fetchMs) {
          rs.fetchMs = rec.fetchMs;
          if (settled) {
            const tEq = rs.pose ? trainTimeAt(rec, rs.pose) : null;
            const off = tEq === null ? null : tEq - nowEpoch;
            if (off !== null && Math.abs(off) <= TRAIN_BLEND_MAX_MS) {
              rs.timeOff = off;
              rs.offX = 0;
              rs.offY = 0;
              rs.offStart = now;
              rs.blendMs = Math.max(TRAIN_BLEND_MS, 2 * Math.abs(off));
            } else {
              capture2D = true;
            }
          } else {
            rs.timeOff = 0;
            rs.offX = 0;
            rs.offY = 0;
          }
        }
        let decay = 0;
        if (rs && settled) {
          const dt = (now - rs.offStart) / rs.blendMs;
          decay = dt >= 1 ? 0 : 1 - smoothstepEase(dt);
        }
        const pose = trainPose(rec, nowEpoch + (rs ? rs.timeOff * decay : 0));
        if (!pose) continue;
        if (onlyBranches && !onlyBranches.has(pose.branchShapeId)) continue;
        const netIds = branchStationIdsRef.current.get(pose.branchShapeId);
        if (!netIds) continue;
        const i = pose.segIndex;
        const idA = shapeIdForRef.current.get(netIds[i]);
        const idB = shapeIdForRef.current.get(netIds[i + 1]);
        if (!idA || !idB) continue;
        const cA = stationCentre(editor, idA);
        const cB = stationCentre(editor, idB);
        if (!cA || !cB) continue;
        const fFwd = pose.reversed ? 1 - pose.f : pose.f;
        const branchId = pose.branchShapeId as TLShapeId;
        let placed: { point: Pt; tangent: Pt };
        if (geo) {
          const seg = lineSegGeo.current.get(branchId)?.[i];
          const arc = segProfilesRef.current.get(branchId)?.[i]?.arc;
          placed =
            seg && seg.length >= 2
              ? arc
                ? pointAlongArc(seg, arc, fFwd)
                : pointAlong(seg, fFwd)
              : straightAt(cA, cB, fFwd);
        } else if (octi) {
          placed = octiPointAt(cA, cB, fFwd);
        } else {
          const profile = segProfilesRef.current.get(branchId)?.[i] ?? null;
          placed = morphPointAt(cA, cB, profile, morphFrac, fFwd);
        }
        const tx = placed.point.x;
        const ty = placed.point.y;
        if (!rs) {
          rs = {
            x: tx,
            y: ty,
            fetchMs: rec.fetchMs,
            pose,
            timeOff: 0,
            offX: 0,
            offY: 0,
            offStart: now,
            blendMs: TRAIN_BLEND_MS,
          };
          render.set(key, rs);
        }
        if (capture2D) {
          rs.timeOff = 0;
          rs.offX = rs.x - tx;
          rs.offY = rs.y - ty;
          rs.offStart = now;
          rs.blendMs = TRAIN_BLEND_MS;
          decay = 1;
        }
        const dispX = tx + rs.offX * decay;
        const dispY = ty + rs.offY * decay;
        rs.x = dispX;
        rs.y = dispY;
        rs.pose = pose;
        const rot = Math.atan2(placed.tangent.y, placed.tangent.x);
        // Rotation pivots the origin (top-left): offset it so the rotated
        // centre R(rot)·(w/2, h/2) lands exactly on the track point.
        const cos = Math.cos(rot);
        const sin = Math.sin(rot);
        const x = dispX - ((TRAIN_W / 2) * cos - (TRAIN_H / 2) * sin);
        const y = dispY - ((TRAIN_W / 2) * sin + (TRAIN_H / 2) * cos);
        seen.add(key);
        const shapeId = shapes.get(key);
        if (!shapeId) {
          if (onlyBranches) continue; // creation belongs to the full pass
          const newId = createShapeId();
          shapes.set(key, newId);
          toCreate.push({
            id: newId,
            type: "train",
            x,
            y,
            rotation: rot,
            isLocked: true,
            props: { w: TRAIN_W, h: TRAIN_H, color: rec.color },
          });
        } else {
          const cur = editor.getShape(shapeId) as TrainShape | undefined;
          if (!cur) continue;
          if (!onScreen(cur.x, cur.y) && !onScreen(x, y)) continue;
          // Skip sub-perceptual jitter (< ~0.5 screen px / 0.02 rad). The
          // rotation delta is wrapped so a heading crossing the ±π seam
          // doesn't read as a ~2π change.
          const dRot = Math.abs(
            ((cur.rotation - rot + 3 * Math.PI) % (2 * Math.PI)) - Math.PI,
          );
          if (
            Math.abs(cur.x - x) > minDelta ||
            Math.abs(cur.y - y) > minDelta ||
            dRot > minRot
          ) {
            toUpdate.push({ id: shapeId, type: "train", x, y, rotation: rot });
          }
        }
      }
      const toDelete: TLShapeId[] = [];
      if (!onlyBranches && !fine) {
        for (const [key, shapeId] of shapes) {
          if (!seen.has(key)) {
            toDelete.push(shapeId);
            shapes.delete(key);
            render.delete(key);
          }
        }
      }
      if (!toCreate.length && !toUpdate.length && !toDelete.length) return;

      // Trains are programmatic; geo mode's readonly instance state blocks all
      // create/update, so lift it just for this synchronous batch, then restore.
      const readonly = editor.getInstanceState().isReadonly;
      if (readonly) editor.updateInstanceState({ isReadonly: false });
      try {
        editor.run(
          () => {
            if (toCreate.length) editor.createShapes<TrainShape>(toCreate);
            if (toUpdate.length) editor.updateShapes(toUpdate);
            if (toDelete.length) editor.deleteShapes(toDelete);
          },
          { ignoreShapeLock: true },
        );
      } finally {
        if (readonly) editor.updateInstanceState({ isReadonly: true });
      }
    },
    [],
  );

  // Poll live arrivals (~30s) and rebuild the train store, keyed by branch.
  useEffect(() => {
    if (!mounted) return;
    let cancelled = false;
    let ac: AbortController | null = null;
    let iv: ReturnType<typeof setInterval> | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      if (!editorRef.current) return;
      const lineIds = [...branchesForLineRef.current.keys()];
      if (lineIds.length === 0) return;
      ac?.abort();
      ac = new AbortController();
      const signal = ac.signal;
      // ONE request for every line: /Line/{ids}/Arrivals accepts a comma list.
      // Per-line requests burst 20 upstream fetches per poll, which exceeds
      // TfL's anonymous rate budget (~12/min measured) and got whole lines
      // 429-dropped. `no-store` skips the browser HTTP cache — one less layer
      // of staleness on the ladder.
      try {
        const res = await fetch(`/api/tfl/Line/${lineIds.join(",")}/Arrivals`, {
          signal,
          cache: "no-store",
        });
        if (!res.ok) return; // keep the old store — trajectories cover the gap
        const preds = (await res.json()) as Prediction[];
        if (cancelled || signal.aborted) return;
        const fetchMs = Date.now();
        const byLine = new Map<string, Prediction[]>();
        for (const p of preds) {
          const list = byLine.get(p.lineId);
          if (list) list.push(p);
          else byLine.set(p.lineId, [p]);
        }
        const next = new Map<string, TrainRecord>();
        for (const [lineId, linePreds] of byLine) {
          const branches = branchesForLineRef.current.get(lineId);
          if (!branches) continue;
          // Stitch each fresh record's synthetic step-0 start from the
          // previous record's exact window (see stitchTrains).
          const recs = stitchTrains(
            trainStore.current,
            deriveTrains(
              linePreds,
              branches,
              naptanToHubRef.current,
              stationPosRef.current,
              lineId,
              lineColorRef.current.get(lineId) ?? "#666666",
              fetchMs,
            ),
          );
          for (const r of recs) next.set(r.key, r);
        }
        trainStore.current = next;
      } catch {
        // aborted or network error — keep the old store this round
      }
    };

    // Wait for the editor + branch registry before the first poll.
    const start = () => {
      if (cancelled) return;
      if (!editorRef.current || branchesForLineRef.current.size === 0) {
        retry = setTimeout(start, 200);
        return;
      }
      poll();
      iv = setInterval(poll, TRAIN_POLL_MS);
    };
    start();

    return () => {
      cancelled = true;
      ac?.abort();
      if (iv) clearInterval(iv);
      if (retry) clearTimeout(retry);
    };
  }, [mounted]);

  // Glide trains between polls with a single rAF loop: a full pass (create/
  // delete, off-screen bookkeeping, coarse gates) every TRAIN_TICK_MS, and a
  // cheap fine pass on every other frame that advances VISIBLE trains in
  // sub-pixel steps — 10Hz half-pixel hops read as stepping once zoomed in.
  useEffect(() => {
    if (!mounted) return;
    if (process.env.NODE_ENV !== "production") {
      // The preview pauses requestAnimationFrame; expose a manual tick so train
      // rendering can be driven/verified there (mirrors the window.editor hook).
      (
        window as unknown as {
          __trainTick?: (b?: ReadonlySet<string>, fine?: boolean) => void;
        }
      ).__trainTick = positionTrains;
    }
    let raf: number | null = null;
    let lastFull = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const now = performance.now();
      if (now - lastFull >= TRAIN_TICK_MS) {
        lastFull = now;
        positionTrains();
      } else {
        positionTrains(undefined, true);
      }
    };
    raf = requestAnimationFrame(loop);
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
      // Also stop the morph tween's rAF so it can't run against a disposed editor.
      if (animFrame.current !== null) cancelAnimationFrame(animFrame.current);
      animating.current = false;
    };
  }, [mounted, positionTrains]);

  if (!mounted) return null;

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div style={toggleWrapStyle} role="group" aria-label="Map layout mode">
        <button
          type="button"
          style={segStyle(!geoMode)}
          aria-pressed={!geoMode}
          onClick={() => setGeoMode(false)}
        >
          Editable
        </button>
        <button
          type="button"
          style={segStyle(geoMode)}
          aria-pressed={geoMode}
          onClick={() => setGeoMode(true)}
        >
          Geographic
        </button>
      </div>
      <Tldraw shapeUtils={shapeUtils} hideUi onMount={handleMount} />
    </div>
  );
}

const toggleWrapStyle: CSSProperties = {
  position: "absolute",
  top: 12,
  right: 12,
  zIndex: 10,
  display: "flex",
  gap: 2,
  padding: 3,
  background: "#ffffff",
  border: "1px solid #e4e4e7",
  borderRadius: 8,
  boxShadow: "0 1px 3px rgba(0, 0, 0, 0.08)",
};

function segStyle(active: boolean): CSSProperties {
  return {
    padding: "5px 11px",
    border: "none",
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    color: active ? "#ffffff" : "#52525b",
    background: active ? "#18181b" : "transparent",
  };
}
