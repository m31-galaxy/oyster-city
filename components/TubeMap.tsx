"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  Tldraw,
  createShapeId,
  react,
  type Editor,
  type TLShapeId,
} from "tldraw";
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
import DebugPanel, { type DebugStats } from "@/components/DebugPanel";
import { getTubeNetwork } from "@/lib/tube/network";
import { hiddenLabels } from "@/lib/tube/labels";
import {
  closedLines,
  getLineOverride,
  lineOverridesRev,
  publishPolledClosures,
  setStationTopology,
} from "@/lib/tube/status";
import { isHollowLine, isNationalRailLine } from "@/lib/tfl/lines";
import { NR_LINE_IDS } from "@/lib/rail/lines";
import { labelRect } from "@/components/shapes/StationShapeUtil";
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
import type { LineStatus, Prediction } from "@/lib/tfl/types";

const shapeUtils = [TubeLineShapeUtil, StationShapeUtil, TrainShapeUtil];
// Double-clicking empty canvas would drop a text shape on the map.
const tldrawOptions = { createTextOnCanvasDoubleClick: false };
const MARKER = 11;
const ANIM_MS = 650;
/** How often to refresh live train predictions (matches TfL's arrivals TTL). */
/** Line-status severities that mean NO trains are running anywhere on the
 * line — Arrivals data for these is ghost stock (parked trains, schedule
 * phantoms) and gets dropped. Part-closure severities (3 Part Suspended,
 * 5 Part Closure, 11 Part Closed) are deliberately absent: those lines run
 * real trains on their unaffected sections.
 *   1 Closed · 2 Suspended · 4 Planned Closure · 8 Bus Service (full rail
 *   replacement) · 16 Not Running · 20 Service Closed (the nightly one) */
const CLOSED_SEVERITIES = new Set([1, 2, 4, 8, 16, 20]);

const TRAIN_POLL_MS = 30_000;
/** How often to reposition trains — trains crawl, so this stays smooth. */
const TRAIN_TICK_MS = 100;
/** Minimum window for easing away a poll correction (widened for big ones). */
const TRAIN_BLEND_MS = 1500;
/** Corrections implying more than this time shift jump instead of blending. */
const TRAIN_BLEND_MAX_MS = 90_000;
/** A 2D correction longer than this (page units) snaps instead of gliding:
 * a cross-map streak draws the eye far more than a blink, and corrections
 * that size are identity/rerouting artefacts, not motion. */
const TRAIN_GLIDE_SNAP_UNITS = 150;
/** A gap between positioning passes longer than this means nobody was
 * watching (hidden tab, system sleep, paused debugger): snap to the current
 * state instead of animating a catch-up — only animate what the user could
 * have seen. */
const WAKE_GAP_MS = 4_000;
/** After a wake, keep snapping (instead of blending) through the first fresh
 * poll, which carries the whole absence's accumulated drift. */
const RESYNC_MS = 35_000;
/** Heading smoothing time constant — reversals/departures rotate over ~0.4s
 * (shortest arc) instead of snapping; fillet sweeps are barely affected. */
const TRAIN_HEADING_TAU_MS = 120;
/** Trajectory look-ahead offsets (ms) used to find the departure heading of a
 * dwelling train, so it turns on the platform before it moves. */
const HEADING_PROBES = [5_000, 15_000, 35_000];
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
 * Recompute which station labels are hidden by decluttering: greedy
 * label-label overlap resolution, interchanges outrank regular stations,
 * ties broken by station id for stability. Label rects live in PAGE space
 * (they scale with the map), so the result is zoom-INDEPENDENT — this only
 * needs to run when the station layout changes (mount, drag, morph settle,
 * selection scale/rotate), never on camera moves. Two regimes are computed:
 * one with every label, one with interchange labels only (below LABEL_ZOOM).
 */
function recomputeLabelDeclutter(editor: Editor) {
  type Entry = {
    id: string;
    interchange: boolean;
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  };
  const entries: Entry[] = [];
  for (const s of editor.getCurrentPageShapes()) {
    if (s.type !== "station") continue;
    const st = s as StationShape;
    if (!st.props.name) continue;
    const r = labelRect(st.props);
    entries.push({
      id: st.id,
      interchange: st.props.interchange,
      x0: st.x + r.x,
      y0: st.y + r.y,
      x1: st.x + r.x + r.w,
      y1: st.y + r.y + r.h,
    });
  }
  entries.sort((a, b) =>
    a.interchange !== b.interchange
      ? a.interchange
        ? -1
        : 1
      : a.id < b.id
        ? -1
        : 1,
  );
  const resolve = (list: Entry[]): ReadonlySet<string> => {
    const hidden = new Set<string>();
    const kept: Entry[] = [];
    for (const e of list) {
      let collides = false;
      for (const k of kept) {
        if (e.x0 < k.x1 && e.x1 > k.x0 && e.y0 < k.y1 && e.y1 > k.y0) {
          collides = true;
          break;
        }
      }
      if (collides) hidden.add(e.id);
      else kept.push(e);
    }
    return hidden;
  };
  hiddenLabels.set({
    all: resolve(entries),
    interOnly: resolve(entries.filter((e) => e.interchange)),
  });
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

/** Tween-frame geometry tolerances (page units): mid-morph the drawn lines
 * may deviate this far from the full-resolution curve, transiently, for the
 * animation's 650ms — the settle pass always draws full resolution. Two
 * precomputed levels, picked per morph by the zoom at its start: the FINE
 * level (~1.5 screen px at z=2) when zoomed in, the COARSE level when the
 * whole network is in view (3 units ≈ 0.3 screen px at fit zoom — invisible,
 * and it's the fit-zoom case where every line must be computed per frame). */
const TWEEN_THIN_TOL_FINE = 0.75;
const TWEEN_THIN_TOL_COARSE = 3;
/** Below this zoom a morph uses the coarse thinning level. */
const TWEEN_COARSE_ZOOM = 0.5;

/** Douglas–Peucker point selection (indices, endpoints always kept). */
function thinIndices(seg: Pt[], tol: number): number[] {
  const keep = new Uint8Array(seg.length);
  keep[0] = 1;
  keep[seg.length - 1] = 1;
  const stack: [number, number][] = [[0, seg.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop()!;
    if (i1 - i0 < 2) continue;
    const a = seg[i0];
    const b = seg[i1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L2 = dx * dx + dy * dy || 1;
    let worst = -1;
    let worstD = tol;
    for (let k = i0 + 1; k < i1; k++) {
      const p = seg[k];
      const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2;
      const px = a.x + t * dx;
      const py = a.y + t * dy;
      const d = Math.hypot(p.x - px, p.y - py);
      if (d > worstD) {
        worstD = d;
        worst = k;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([i0, worst], [worst, i1]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < seg.length; i++) if (keep[i]) out.push(i);
  return out;
}

/** Decompose each per-pair segment into SegProfiles (along/perp/arc): `full`
 * resolution for the settle evaluators and the trains' morphPointAt, plus
 * two Douglas–Peucker-thinned variants consumed ONLY by tween frames — the
 * morph blended ~45k full-resolution points per frame network-wide, which
 * was the dominant morph cost after write batching. */
function buildSegProfiles(segs: (Pt[] | null)[]): {
  full: (SegProfile | null)[];
  coarse: (SegProfile | null)[];
  coarser: (SegProfile | null)[];
} {
  const full: (SegProfile | null)[] = [];
  const coarse: (SegProfile | null)[] = [];
  const coarser: (SegProfile | null)[] = [];
  for (const seg of segs) {
    if (!seg || seg.length < 2) {
      full.push(null);
      coarse.push(null);
      coarser.push(null);
      continue;
    }
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
    full.push({ along, perp, arc });
    const pick = (tol: number): SegProfile => {
      const kept = thinIndices(seg, tol);
      return {
        along: kept.map((i) => along[i]),
        perp: kept.map((i) => perp[i]),
        arc: kept.map((i) => arc[i]),
      };
    };
    coarse.push(pick(TWEEN_THIN_TOL_FINE));
    coarser.push(pick(TWEEN_THIN_TOL_COARSE));
  }
  return { full, coarse, coarser };
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

/** A line-shape update built without writing, so callers can batch every
 * line (and everything else in the frame) into ONE updateShapes call —
 * per-shape updateShape calls were pure call overhead at 365/frame during
 * the mode morph (~14.5ms of a 39ms frame). */
type ShapePartial = {
  id: TLShapeId;
  type: "tube-line" | "station";
  x: number;
  y: number;
  props?: { w: number; h: number; d: string };
};

/** Push casing (+ core-twin mirror) partials for an already-computed path. */
function pushLinePartials(
  acc: ShapePartial[],
  lineId: TLShapeId,
  path: ReturnType<typeof pathFromPoints>,
  coreId?: TLShapeId,
) {
  acc.push({
    id: lineId,
    type: "tube-line",
    x: path.x,
    y: path.y,
    props: { w: path.w, h: path.h, d: path.d },
  });
  // A hollow fragment's white core rides along as a twin shape: mirror the
  // computed path instead of recomputing it.
  if (coreId) {
    acc.push({
      id: coreId,
      type: "tube-line",
      x: path.x,
      y: path.y,
      props: { w: path.w, h: path.h, d: path.d },
    });
  }
}

/**
 * Build (not write) one line's redraw partials. With `curve` (the projected
 * OSM track) it follows the real geography; otherwise it draws through its
 * stations' current centres — bent octilinearly when `octi` (the editable
 * layout), or straight. Reads live shape state, so it serves the SETTLED
 * regimes only (drags, mode settle); the morph tick blends per-segment from
 * its own tween-pose map instead.
 */
function buildLinePartials(
  acc: ShapePartial[],
  editor: Editor,
  line: TubeLineShape,
  curve: Pt[] | null,
  octi: boolean,
  coreId?: TLShapeId,
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
  pushLinePartials(acc, line.id, pathFromPoints(pts), coreId);
}

/**
 * Redraw every line in one batched write. Pass `lineGeo` to draw OSM curves
 * where available; lines without a curve fall back to `octi` octilinear
 * (editable) or straight chords. Core twins are never recomputed directly —
 * they mirror their casing.
 */
function recomputeAllLines(
  editor: Editor,
  lineGeo: Map<TLShapeId, Pt[]> | null,
  octi: boolean,
  coreIdFor: ReadonlyMap<TLShapeId, TLShapeId>,
) {
  const acc: ShapePartial[] = [];
  for (const shape of editor.getCurrentPageShapes()) {
    if (shape.type === "tube-line" && !shape.props.core) {
      buildLinePartials(
        acc,
        editor,
        shape,
        lineGeo?.get(shape.id) ?? null,
        octi,
        coreIdFor.get(shape.id),
      );
    }
  }
  if (!acc.length) return;
  editor.run(
    () => {
      editor.updateShapes(acc);
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
// The "mounted" store never changes after hydration, but useSyncExternalStore
// still needs a stable subscribe function to avoid re-subscribing per render.
const emptySubscribe = () => () => {};

export default function TubeMap() {
  // False on the server and for the hydration render, true immediately after —
  // gates tldraw (client-only) past SSR without a setState-in-effect cascade.
  const mounted = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
  const [geoMode, setGeoMode] = useState(false);

  const editorRef = useRef<Editor | null>(null);
  const geoPos = useRef<Map<TLShapeId, Pose>>(new Map());
  const customPos = useRef<Map<TLShapeId, Pose>>(new Map());
  const lineGeo = useRef<Map<TLShapeId, Pt[]>>(new Map());
  const lineSegGeo = useRef<Map<TLShapeId, (Pt[] | null)[]>>(new Map());
  const animating = useRef(false);
  const animFrame = useRef<number | null>(null);
  /** Deferred settle work (declutter + camera re-measure), one frame after
   * the morph's settle redraw — cancelled if a new morph starts first. */
  const settleExtras = useRef<number | null>(null);
  const lastDeclutter = useRef(0);
  const declutterTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Wall-clock of the last positioning pass + the post-wake snap window. */
  const lastPassRef = useRef(0);
  const resyncUntilRef = useRef(0);
  /** Hollow casing shape id -> its white-core twin (mirrors the casing's path). */
  const coreIdForRef = useRef<Map<TLShapeId, TLShapeId>>(new Map());

  /** Re-measure the camera-constraint region from current content bounds. */
  const updateCameraConstraintsRef = useRef<(() => void) | null>(null);

  /** Station centres for the CURRENT morph frame, maintained in plain JS by
   * the tween (null while settled). One source of truth: the tick's line
   * geometry, its station writes, and the trains' placedFor all read THIS —
   * mixed sources would detach trains from lines, and reading shapes back
   * mid-frame sees stale values once the frame's writes are batched. */
  const morphCentresRef = useRef<Map<TLShapeId, Pt> | null>(null);

  // Debug-panel telemetry (written by the poll loop / positioning passes,
  // read at 1Hz while the panel is open — see collectDebugStats).
  const debugPollRef = useRef({
    lastPollMs: 0,
    tflOk: false,
    tflPreds: 0,
    railSource: "off",
    railStatus: "off",
    railPreds: 0,
    closedLines: [] as string[],
  });
  const debugPerfRef = useRef({
    fullMs: 0,
    fineMs: 0,
    morphMs: 0,
    frames: 0,
    prevFrames: 0,
    prevAt: 0,
  });

  // Live-train state (populated in handleMount, driven by the poll + rAF loops).
  const shapeIdForRef = useRef<Map<string, TLShapeId>>(new Map());
  const branchesForLineRef = useRef<Map<string, BranchInfo[]>>(new Map());
  const branchStationIdsRef = useRef<Map<string, string[]>>(new Map());
  const segProfilesRef = useRef<Map<TLShapeId, (SegProfile | null)[]>>(
    new Map(),
  );
  /** Douglas–Peucker-thinned twins of segProfilesRef, used ONLY by morph
   * tween frames (settle + trains stay full-resolution). Two levels; the
   * morph picks by its starting zoom. */
  const segProfilesCoarseRef = useRef<Map<TLShapeId, (SegProfile | null)[]>>(
    new Map(),
  );
  const segProfilesCoarserRef = useRef<Map<TLShapeId, (SegProfile | null)[]>>(
    new Map(),
  );
  const naptanToHubRef = useRef<Record<string, string>>({});
  const stationPosRef = useRef<Map<string, [number, number]>>(new Map());
  const lineColorRef = useRef<Map<string, string>>(new Map());
  const trainStore = useRef<Map<string, TrainRecord>>(new Map());
  const trainShapes = useRef<Map<string, TLShapeId>>(new Map());
  // Per-train render state for easing away the position correction each poll.
  // Preferred: a TIME offset driven by a critically damped spring — display
  // time = wall clock + offset, so the train runs briefly slow/fast, never
  // visibly backward, and a fresh poll mid-glide re-aims the spring WITHOUT a
  // speed jump (springV carries across captures — velocity continuity).
  // Fallback: a decaying 2D point offset when the new trajectory doesn't pass
  // through the displayed pose (branch switch, reroute).
  const trainRender = useRef<
    Map<
      string,
      {
        x: number;
        y: number;
        fetchMs: number;
        pose: TrainPose | null;
        /** Spring state: time offset (ms), its velocity (ms/s), stiffness (1/s),
         * last integration timestamp (perf ms), last displayed epoch (ms). */
        springO: number;
        springV: number;
        springW: number;
        springT: number;
        dispTime: number;
        /** Smoothed displayed heading (rad); NaN until first placement. */
        rot: number;
        offX: number;
        offY: number;
        offStart: number;
        blendMs: number;
        /** Memoised dwell departure heading + its cache key (see the heading
         * probe block) — the 3-probe look-ahead is per-dwell, not per-frame. */
        headKey?: string;
        headRot?: number;
        /** geomGenRef value at last placement — guards the dwell fast-path
         * against line geometry moving under a stationary train. */
        geomGen?: number;
      }
    >
  >(new Map());
  /** 0 = editable, 1 = geographic, in between while the morph tween runs. */
  const morphFracRef = useRef(0);
  /** Bumped whenever line geometry moves under settled trains (drag redraws,
   * morph settle) — invalidates memoised dwell headings. */
  const geomGenRef = useRef(0);

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
    (onlyBranches?: ReadonlySet<string>, fine = false, tween = false) => {
      const editor = editorRef.current;
      if (!editor) return;
      if (fine && editor.getZoomLevel() < 0.5) return;
      const store = trainStore.current;
      const shapes = trainShapes.current;
      const render = trainRender.current;
      if (store.size === 0 && shapes.size === 0) return;
      const now = performance.now();
      const nowEpoch = Date.now();
      // Debug telemetry: EMA of pass cost, recorded at every exit below.
      // Tween passes are counted inside the tick's morphMs instead.
      const recordPass = () => {
        if (tween) return;
        const p = debugPerfRef.current;
        const spent = performance.now() - now;
        if (fine) p.fineMs = p.fineMs ? p.fineMs * 0.9 + spent * 0.1 : spent;
        else p.fullMs = p.fullMs ? p.fullMs * 0.9 + spent * 0.1 : spent;
      };
      // Absence detection: if positioning passes stopped for a while (hidden
      // tab, sleep), drop all per-train blend/heading state — the next pass
      // places everything at its true current position before the user sees a
      // frame, instead of animating a mass catch-up they never watched. Keep
      // snapping through the first fresh poll (RESYNC_MS), which carries the
      // absence's accumulated data drift.
      if (lastPassRef.current && nowEpoch - lastPassRef.current > WAKE_GAP_MS) {
        resyncUntilRef.current = nowEpoch + RESYNC_MS;
        render.clear();
      }
      lastPassRef.current = nowEpoch;
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
      // Tween passes use a proportional margin (the morph sweeps shapes fast,
      // so a fixed 50-unit apron under-covers at speed); the ambient 10Hz
      // full pass is the backstop that trues late sweep-ins within ≤100ms.
      const apron = tween ? Math.max(vp.w, vp.h) * 0.25 : 50;
      const vpX0 = vp.x - apron;
      const vpY0 = vp.y - apron;
      const vpX1 = vp.x + vp.w + apron;
      const vpY1 = vp.y + vp.h + apron;
      const onScreen = (px: number, py: number) =>
        px >= vpX0 && px <= vpX1 && py >= vpY0 && py <= vpY1;

      // Station centres memoised for THIS pass (positions can't change inside
      // a synchronous pass; every pass starts a fresh memo).
      const centreCache = new Map<TLShapeId, Pt | null>();
      const centreOf = (id: TLShapeId): Pt | null => {
        let c = centreCache.get(id);
        if (c === undefined) {
          c = stationCentre(editor, id);
          centreCache.set(id, c);
        }
        return c;
      };

      // Page-space point + tangent for a pose, using the geometry that matches
      // how the line is currently drawn. Shared by the main placement and the
      // dwell look-ahead that pre-aims a stopped train's heading.
      const placedFor = (
        pose: TrainPose,
      ): { point: Pt; tangent: Pt } | null => {
        const netIds = branchStationIdsRef.current.get(pose.branchShapeId);
        if (!netIds) return null;
        const i = pose.segIndex;
        const idA = shapeIdForRef.current.get(netIds[i]);
        const idB = shapeIdForRef.current.get(netIds[i + 1]);
        if (!idA || !idB) return null;
        // Mid-morph, centres come from the tween's own pose map (set for
        // exactly the animation's duration) so trains ride the SAME geometry
        // the lines were drawn from this frame; settled passes read live —
        // memoised per pass, since ~140 visible trains share a much smaller
        // station set and each transform read costs more than the map hit.
        const tweenMap = morphCentresRef.current;
        const cA = tweenMap?.get(idA) ?? centreOf(idA);
        const cB = tweenMap?.get(idB) ?? centreOf(idB);
        if (!cA || !cB) return null;
        const fFwd = pose.reversed ? 1 - pose.f : pose.f;
        const branchId = pose.branchShapeId as TLShapeId;
        if (geo) {
          const seg = lineSegGeo.current.get(branchId)?.[i];
          const arc = segProfilesRef.current.get(branchId)?.[i]?.arc;
          return seg && seg.length >= 2
            ? arc
              ? pointAlongArc(seg, arc, fFwd)
              : pointAlong(seg, fFwd)
            : straightAt(cA, cB, fFwd);
        }
        if (octi) return octiPointAt(cA, cB, fFwd);
        const profile = segProfilesRef.current.get(branchId)?.[i] ?? null;
        return morphPointAt(cA, cB, profile, morphFrac, fFwd);
      };

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
        // On a fresh poll, convert the correction into a TIME offset that a
        // critically damped spring drives back to zero: the train runs
        // briefly slow (or gently catches up) instead of teleporting or
        // sliding backward. The spring's velocity carries across captures, so
        // a poll landing mid-glide re-aims it with NO speed jump; a hard
        // monotonic clamp keeps display speed within 0.25x-1.75x of real.
        // Falls back to a decaying 2D point offset when the new trajectory
        // doesn't pass the displayed pose (reroute / branch switch). Skipped
        // during the morph, where the whole line is already moving.
        let rs = render.get(key);
        // Fine and tween passes smooth what's already (near) on screen —
        // BEFORE any pose computation, which is most of a pass's cost;
        // initialisation and newly-visible trains belong to the 10Hz full
        // pass.
        if ((fine || tween) && (!rs || !onScreen(rs.x, rs.y))) continue;
        let capture2D = false;
        if (rs && rs.fetchMs !== rec.fetchMs) {
          rs.fetchMs = rec.fetchMs;
          if (nowEpoch < resyncUntilRef.current) {
            // Post-wake window: present fresh data instantly, no blending.
            rs.springO = 0;
            rs.springV = 0;
            rs.offX = 0;
            rs.offY = 0;
          } else if (settled) {
            const tEq = rs.pose ? trainTimeAt(rec, rs.pose) : null;
            const off = tEq === null ? null : tEq - nowEpoch;
            if (off !== null && Math.abs(off) <= TRAIN_BLEND_MAX_MS) {
              // Position-continuous by construction (the new trajectory
              // passes the displayed pose at nowEpoch + off); springV is
              // deliberately NOT reset — velocity continuity.
              rs.springO = off;
              // Stiffness ~4/|off|s: small corrections settle in ~1.5-3s and
              // a 45s correction in ~80s (like the old 2x|off| window). The
              // steepest stretch rides the 0.25x monotonic clamp below.
              rs.springW = Math.min(3, 4000 / Math.max(1334, Math.abs(off)));
              rs.offX = 0;
              rs.offY = 0;
            } else {
              capture2D = true;
              rs.springO = 0;
              rs.springV = 0;
            }
          } else {
            rs.springO = 0;
            rs.springV = 0;
            rs.offX = 0;
            rs.offY = 0;
          }
        }
        let decay = 0;
        let dispTime = nowEpoch;
        let headDtMs = 0;
        if (rs) {
          headDtMs = Math.max(0, nowEpoch - rs.springT);
          if (settled) {
            // Integrate the critically damped spring (closed form), then
            // clamp display time to monotonic forward within [0.25, 1.75]x.
            // Everything runs on the SAME clock as display time (Date.now):
            // deriving dt from performance.now would freeze trains whenever
            // the two clocks diverge (system sleep/clock slew — and the
            // virtual-time test harness).
            const dtMs = Math.max(0, nowEpoch - rs.springT);
            const dtS = dtMs / 1000;
            const a = rs.springV + rs.springW * rs.springO;
            const e = Math.exp(-rs.springW * dtS);
            rs.springO = (rs.springO + a * dtS) * e;
            rs.springV = (rs.springV - a * rs.springW * dtS) * e;
            dispTime = nowEpoch + rs.springO;
            if (dtMs > 0) {
              const lo = rs.dispTime + 0.25 * dtMs;
              const hi = rs.dispTime + 1.75 * dtMs;
              if (dispTime < lo || dispTime > hi) {
                dispTime = dispTime < lo ? lo : hi;
                rs.springO = dispTime - nowEpoch;
                // Re-sync the spring's velocity to the APPLIED derivative so
                // the clamp releasing doesn't kink the display speed.
                rs.springV = (dispTime - rs.dispTime - dtMs) / dtS;
              }
            }
            const dt2D = (now - rs.offStart) / rs.blendMs;
            decay = dt2D >= 1 ? 0 : 1 - smoothstepEase(dt2D);
          } else {
            rs.springO = 0;
            rs.springV = 0;
          }
          rs.springT = nowEpoch;
          rs.dispTime = dispTime;
        }
        const pose = trainPose(rec, dispTime);
        if (!pose) continue;
        if (onlyBranches && !onlyBranches.has(pose.branchShapeId)) continue;
        // Dwell fast-path (fine passes): a stationary train whose corrections
        // have decayed, heading has settled and line geometry hasn't moved
        // renders exactly where it already is — skip the geometry eval, which
        // is the bulk of per-train cost, for the ~half of the visible fleet
        // dwelling at any moment. A dwelling pose sits pinned at f=0, so its
        // position can't drift with display time; departure flips
        // pose.moving, which lands in the full pipeline again.
        if (
          fine &&
          !pose.moving &&
          rs &&
          rs.pose &&
          !rs.pose.moving &&
          rs.pose.branchShapeId === pose.branchShapeId &&
          rs.pose.segIndex === pose.segIndex &&
          rs.pose.reversed === pose.reversed &&
          rs.geomGen === geomGenRef.current &&
          ((now - rs.offStart) / rs.blendMs >= 1 ||
            (rs.offX === 0 && rs.offY === 0)) &&
          rs.headRot !== undefined &&
          Math.abs(rs.rot - rs.headRot) < minRot
        ) {
          seen.add(key);
          continue;
        }
        const placed = placedFor(pose);
        if (!placed) continue;
        const tx = placed.point.x;
        const ty = placed.point.y;
        if (!rs) {
          rs = {
            x: tx,
            y: ty,
            fetchMs: rec.fetchMs,
            pose,
            springO: 0,
            springV: 0,
            springW: 3,
            springT: nowEpoch,
            dispTime: nowEpoch,
            rot: Number.NaN,
            offX: 0,
            offY: 0,
            offStart: now,
            blendMs: TRAIN_BLEND_MS,
          };
          render.set(key, rs);
        }
        if (capture2D) {
          const ox = rs.x - tx;
          const oy = rs.y - ty;
          if (Math.hypot(ox, oy) > TRAIN_GLIDE_SNAP_UNITS) {
            rs.offX = 0;
            rs.offY = 0;
            decay = 0;
          } else {
            rs.offX = ox;
            rs.offY = oy;
            rs.offStart = now;
            rs.blendMs = TRAIN_BLEND_MS;
            decay = 1;
          }
        }
        const dispX = tx + rs.offX * decay;
        const dispY = ty + rs.offY * decay;
        rs.x = dispX;
        rs.y = dispY;
        rs.pose = pose;
        rs.geomGen = geomGenRef.current;
        // Heading: smooth the displayed rotation toward the target tangent
        // (shortest arc, tau ~120ms) so reversals and departures swing over
        // ~0.4s instead of snapping. A dwelling on-screen train aims at its
        // DEPARTURE tangent (probe the trajectory ahead), turning on the
        // platform before it moves.
        let targetRot = Math.atan2(placed.tangent.y, placed.tangent.x);
        if (settled && !pose.moving && onScreen(dispX, dispY)) {
          // The probed departure tangent only changes when the record
          // refreshes, the dwell step changes, or the line geometry moves —
          // memoise on those (probing cost 3 trainPose+placedFor per train
          // per frame, which dominated the fine pass at editing zooms).
          const headKey = `${rec.fetchMs}:${pose.branchShapeId}:${pose.segIndex}:${pose.reversed}:${geomGenRef.current}`;
          if (rs.headKey === headKey && rs.headRot !== undefined) {
            targetRot = rs.headRot;
          } else {
            for (const k of HEADING_PROBES) {
              const fut = trainPose(rec, dispTime + k);
              if (!fut) break;
              if (fut.moving) {
                const fp = placedFor(fut);
                if (fp) targetRot = Math.atan2(fp.tangent.y, fp.tangent.x);
                break;
              }
            }
            rs.headKey = headKey;
            rs.headRot = targetRot;
          }
        }
        let rot: number;
        if (Number.isFinite(rs.rot)) {
          const delta =
            ((targetRot - rs.rot + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
          rot =
            rs.rot + delta * (1 - Math.exp(-headDtMs / TRAIN_HEADING_TAU_MS));
        } else {
          rot = targetRot; // first placement — no spawn swing
        }
        rs.rot = rot;
        // Rotation pivots the origin (top-left): offset it so the rotated
        // centre R(rot)·(w/2, h/2) lands exactly on the track point.
        const cos = Math.cos(rot);
        const sin = Math.sin(rot);
        const x = dispX - ((TRAIN_W / 2) * cos - (TRAIN_H / 2) * sin);
        const y = dispY - ((TRAIN_W / 2) * sin + (TRAIN_H / 2) * cos);
        seen.add(key);
        const shapeId = shapes.get(key);
        if (!shapeId) {
          // Creation belongs to the ambient full pass.
          if (onlyBranches || tween) continue;
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
      if (!onlyBranches && !fine && !tween) {
        for (const [key, shapeId] of shapes) {
          if (!seen.has(key)) {
            toDelete.push(shapeId);
            shapes.delete(key);
            render.delete(key);
          }
        }
      }
      if (!toCreate.length && !toUpdate.length && !toDelete.length) {
        recordPass();
        return;
      }

      // Trains are programmatic; geo mode's readonly instance state blocks all
      // create/update, so lift it just for this synchronous batch, then
      // restore. History is skipped too: an undo that removed a train shape
      // would hide that train for good — its key still maps to the dead id,
      // so the create branch never runs again.
      const readonly = editor.getInstanceState().isReadonly;
      if (readonly) editor.updateInstanceState({ isReadonly: false });
      try {
        editor.run(
          () => {
            if (toCreate.length) editor.createShapes<TrainShape>(toCreate);
            if (toUpdate.length) editor.updateShapes(toUpdate);
            if (toDelete.length) editor.deleteShapes(toDelete);
          },
          { ignoreShapeLock: true, history: "ignore" },
        );
      } finally {
        if (readonly) editor.updateInstanceState({ isReadonly: true });
      }
      recordPass();
    },
    [],
  );

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
    // Station -> serving lines: lib/tube/status derives the closed-station
    // set from this (a station dims only when every one of its lines is
    // closed).
    const stationLines = new Map<string, string[]>();
    for (const line of lines) {
      for (const sid of line.stationIds) {
        lineCount.set(sid, (lineCount.get(sid) ?? 0) + 1);
        if (!colourFor.has(sid)) colourFor.set(sid, line.color);
        const served = stationLines.get(sid);
        if (!served) stationLines.set(sid, [line.id]);
        else if (!served.includes(line.id)) served.push(line.id);
      }
    }
    setStationTopology(stationLines);
    const stations = net.stations.filter((s) => lineCount.has(s.id));
    const centreFor = new Map<string, Pt>(
      stations.map((s) => [s.id, { x: s.cx, y: s.cy }]),
    );
    const shapeIdFor = new Map<string, TLShapeId>(
      stations.map((s) => [s.id, createShapeId()]),
    );
    shapeIdForRef.current = shapeIdFor;
    // Station shape id -> initial centre point, for fork/crossing detection
    // while grouping the line shapes below.
    const editorStationCentres = new Map<TLShapeId, Pt>(
      stations.map((s) => [shapeIdFor.get(s.id)!, { x: s.cx, y: s.cy }]),
    );

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

    // One casing shape per fragment, plus a white-core twin for hollow lines.
    // Twins are appended after ALL of their line's casings so every core sits
    // above every casing of the same line — at forks, one fragment's colour
    // stroke can then never truncate another fragment's white channel. Cross-
    // line z-order is unchanged (later lines still occlude earlier ones).
    type TubeLineInit = {
      id: TLShapeId;
      type: "tube-line";
      x: number;
      y: number;
      isLocked: boolean;
      props: TubeLineShape["props"];
    };
    const lineShapes: TubeLineInit[] = [];
    // The current line's fragments, accumulated until the line id changes:
    // casing init + optional core init + station set + drawn polyline (for
    // fork/crossing detection).
    let group: {
      casing: TubeLineInit;
      core: TubeLineInit | null;
      stations: Set<TLShapeId>;
      poly: Pt[];
    }[] = [];
    let prevLineId: string | null = null;
    const segsCross = (a: Pt, b: Pt, c: Pt, d: Pt) => {
      const d1 = (d.x - c.x) * (a.y - c.y) - (d.y - c.y) * (a.x - c.x);
      const d2 = (d.x - c.x) * (b.y - c.y) - (d.y - c.y) * (b.x - c.x);
      const d3 = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      const d4 = (b.x - a.x) * (d.y - a.y) - (b.y - a.y) * (d.x - a.x);
      return d1 * d2 < 0 && d3 * d4 < 0;
    };
    // Emit a line's fragments with cores interleaved so channels merge ONLY
    // between fragments that fork from a shared station: each core is placed
    // right after the last casing among itself and its fork partners. Fork
    // partners' casings land before the core (no channel cut-off at the
    // junction); unrelated later casings land after it, so a same-line
    // CROSSING occludes like two distinct lines instead of reading as a
    // four-way junction. A pair that shares a station but ALSO crosses
    // elsewhere (the DLR delta's bypass) is demoted to strict layering: the
    // shared station still merges via the other fragments converging there,
    // while the mid-route crossing occludes.
    const flushGroup = () => {
      const partners = (
        g: (typeof group)[number],
        h: (typeof group)[number],
      ) => {
        let shared: Pt[] | null = null;
        for (const s of h.stations) {
          if (g.stations.has(s)) {
            const st = editorStationCentres.get(s);
            if (st) (shared ??= []).push(st);
          }
        }
        if (!shared) return false;
        // Crossing away from every shared station -> not fork partners.
        for (let i = 1; i < g.poly.length; i++) {
          for (let j = 1; j < h.poly.length; j++) {
            if (!segsCross(g.poly[i - 1], g.poly[i], h.poly[j - 1], h.poly[j]))
              continue;
            const mid = {
              x: (g.poly[i - 1].x + g.poly[i].x) / 2,
              y: (g.poly[i - 1].y + g.poly[i].y) / 2,
            };
            if (shared.every((s) => Math.hypot(s.x - mid.x, s.y - mid.y) > 25))
              return false;
          }
        }
        return true;
      };
      const n = group.length;
      const partner: boolean[][] = Array.from({ length: n }, () =>
        Array(n).fill(false),
      );
      const demotedPairs: [number, number][] = [];
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const shares = [...group[j].stations].some((s) =>
            group[i].stations.has(s),
          );
          if (!shares) continue;
          if (partners(group[i], group[j])) {
            partner[i][j] = partner[j][i] = true;
          } else {
            demotedPairs.push([i, j]);
          }
        }
      }
      // A crossing pair is violated when a fork link stretches a core's
      // window past the crossing counterpart's casing. The emission ORDER is
      // itself a degree of freedom: first try relocating the offending fork
      // partner's casing to just before the counterpart — that satisfies the
      // layering while keeping the junction merge. (Thameslink's King's
      // Cross: the main fragment crosses London Bridge–Peckham Rye away from
      // their shared station, and its Finsbury Park fork partner was emitted
      // after that counterpart; moving the partner earlier keeps both the
      // crossing occlusion and the King's Cross channel merge.) Only when a
      // move repeats — a genuine cycle, like the DLR delta's two crossings
      // chained through fork links — is the fork link dropped as before: the
      // sacrificed merge sits within a few px of the shared station, hidden
      // by the station marker, while the crossing is out in the open. Every
      // round either performs a never-tried move or removes a link, so this
      // terminates.
      const ord = group.map((_, i) => i); // emission slots -> fragment index
      const slotOf: number[] = new Array(n).fill(0);
      const tried = new Set<string>();
      let coreSlot: number[] = [];
      for (let guard = 0; guard <= n * n + demotedPairs.length * n; guard++) {
        ord.forEach((f, s) => (slotOf[f] = s));
        coreSlot = group.map((_, j) => {
          let last = slotOf[j];
          for (let k = 0; k < n; k++)
            if (partner[j][k]) last = Math.max(last, slotOf[k]);
          return last;
        });
        // With a's casing emitted before b's, the crossing pair is strictly
        // layered iff a's core also lands before b's casing.
        let va = -1;
        let vb = -1;
        for (const [i, j] of demotedPairs) {
          const [a, b] = slotOf[i] < slotOf[j] ? [i, j] : [j, i];
          if (coreSlot[a] >= slotOf[b]) {
            va = a;
            vb = b;
            break;
          }
        }
        if (va < 0) break;
        // The fork partner holding a's core at/after b's casing.
        let off = -1;
        for (let k = 0; k < n; k++)
          if (partner[va][k] && slotOf[k] >= slotOf[vb])
            if (off < 0 || slotOf[k] > slotOf[off]) off = k;
        if (off < 0) break;
        const moveKey = `${off}->${vb}`;
        if (!tried.has(moveKey)) {
          tried.add(moveKey);
          ord.splice(slotOf[off], 1);
          ord.splice(ord.indexOf(vb), 0, off);
        } else {
          partner[va][off] = partner[off][va] = false;
        }
      }
      for (const f of ord) {
        lineShapes.push(group[f].casing);
        group.forEach((h, j) => {
          if (h.core && coreSlot[j] === slotOf[f]) lineShapes.push(h.core);
        });
      }
      group = [];
    };
    for (const line of lines) {
      if (line.id !== prevLineId) {
        flushGroup();
        prevLineId = line.id;
      }
      const lineId = createShapeId();
      const ids = line.stationIds
        .map((sid) => shapeIdFor.get(sid))
        .filter((id): id is TLShapeId => !!id);
      const centres = line.stationIds
        .map((sid) => centreFor.get(sid))
        .filter((c): c is Pt => !!c);
      // Mount starts in editable mode → octilinear connectors.
      const poly = octilinearPoints(centres);
      const path = pathFromPoints(poly);
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
        const profiles = buildSegProfiles(segs);
        segProfilesRef.current.set(lineId, profiles.full);
        segProfilesCoarseRef.current.set(lineId, profiles.coarse);
        segProfilesCoarserRef.current.set(lineId, profiles.coarser);
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
      const hollow = isHollowLine(line.id);
      const casing: TubeLineInit = {
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
          hollow,
          core: false,
          dashed: isNationalRailLine(line.id),
          lineId: line.id,
          stationIds: ids,
        },
      };
      let core: TubeLineInit | null = null;
      if (hollow) {
        const coreId = createShapeId();
        coreIdForRef.current.set(lineId, coreId);
        core = {
          ...casing,
          id: coreId,
          props: { ...casing.props, core: true },
        };
      }
      group.push({ casing, core, stations: new Set(ids), poly });
    }
    flushGroup();

    // The initial network build is not an undoable user action — without
    // this, Cmd+Z on a fresh load would try to unwind the whole map.
    editor.run(
      () => {
        editor.createShapes<TubeLineShape | StationShape>([
          ...lineShapes,
          ...stationShapes,
        ]);
      },
      { history: "ignore" },
    );
    recomputeLabelDeclutter(editor);

    // Stations are draggable but otherwise immutable. hideUi keeps tldraw's
    // keyboard shortcuts and clipboard events mounted, so delete / cut /
    // paste / duplicate (and alt-drag cloning) all reach the editor — each
    // is vetoed once at its deepest chokepoint rather than per entry point.
    //
    // Deleting (⌫, cut, the eraser tool): cancelled in the store, which
    // covers every route including undo/redo diffs.
    editor.sideEffects.registerBeforeDeleteHandler("shape", (shape) =>
      shape.type === "station" ? false : undefined,
    );
    // Any other change to a station may only MOVE it: x/y (and rotation,
    // which onRotate pins to 0) pass through, everything else — props, lock,
    // opacity, z-order, meta — is pinned. A reparent (grouping) is vetoed
    // outright: its x/y are parent-local, so letting them through would
    // teleport the marker.
    editor.sideEffects.registerBeforeChangeHandler("shape", (prev, next) => {
      if (next.type !== "station") return next;
      if (
        prev.props === next.props &&
        prev.parentId === next.parentId &&
        prev.isLocked === next.isLocked &&
        prev.opacity === next.opacity &&
        prev.index === next.index &&
        prev.meta === next.meta
      ) {
        return next; // pure move — the hot path (drags, the mode morph)
      }
      if (prev.type !== "station" || prev.parentId !== next.parentId) {
        return prev;
      }
      return {
        ...next,
        props: prev.props,
        isLocked: prev.isLocked,
        opacity: prev.opacity,
        index: prev.index,
        meta: prev.meta,
      };
    });
    // Creating station copies: duplicate (Cmd+D) and alt-drag cloning ask
    // canCreateShapes first and bail cleanly when refused (alt-drag falls
    // back to a plain move); paste funnels through putContentOntoCurrentPage,
    // where stations are stripped from the content. Grouping would strand an
    // empty group shape (its reparent is vetoed above), so refuse it too.
    // Trains and lines are unaffected — every check is station-specific.
    const isStation = (s: TLShapeId | { type: string }) =>
      (typeof s === "string" ? editor.getShape(s)?.type : s.type) === "station";
    const origCanCreate = editor.canCreateShapes.bind(editor);
    editor.canCreateShapes = (shapes) =>
      origCanCreate(shapes) && !shapes.some(isStation);
    const stnEditor = editor as unknown as {
      putContentOntoCurrentPage(
        content: { shapes: { type: string }[] },
        options?: object,
      ): Editor;
      groupShapes(
        shapes: (TLShapeId | { type: string })[],
        opts?: object,
      ): Editor;
    };
    const origPutContent = stnEditor.putContentOntoCurrentPage.bind(editor);
    stnEditor.putContentOntoCurrentPage = (content, options) => {
      const shapes = content.shapes.filter((s) => s.type !== "station");
      if (shapes.length === 0) return editor;
      return origPutContent(
        shapes.length === content.shapes.length
          ? content
          : { ...content, shapes },
        options,
      );
    };
    const origGroup = stnEditor.groupShapes.bind(editor);
    stnEditor.groupShapes = (shapes, opts) =>
      shapes.some(isStation) ? editor : origGroup(shapes, opts);

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

    // Snapping: a dragged station snaps when its centre comes IN LINE with
    // another station's centre (stations expose only their centre as snap
    // geometry — StationShapeUtil) or at equal SPACING between stations (gap
    // snapping; markers share one size, so equal bound gaps = equal centre
    // spacing). Lines and trains opt out entirely (canSnap false), so both
    // kinds of snap only ever reference stations. Snap mode is ON by default
    // (hold Cmd/Ctrl to drag free — tldraw only snaps while the modifier is
    // down otherwise).
    editor.user.updateUserPreferences({ isSnapMode: true });

    // Camera constraints: the viewport can never lose the map — at least
    // ~130 screen px of it stays visible however far you pan or zoom
    // ('outside' behaviour + padding). The constrained region is the LIVE
    // content bounds, re-measured whenever a station moves, so dragging a
    // node outward grows the roaming range with it (edge-scrolling a
    // selection to the viewport edge keeps panning as the frontier recedes)
    // instead of dead-ending at a fixed border. tldraw's 'outside' clamp
    // drops bounds.x/y — the region is effectively anchored at the page
    // origin — so the true origin lives in camRegion and the clamp is
    // conjugated through it: shift into region-local space, clamp, shift
    // back. (Translation-invariant, so the zoom handling is unaffected.)
    const camRegion = { x: 0, y: 0 };
    const camEditor = editor as unknown as {
      getConstrainedCamera(
        point: { x: number; y: number; z?: number },
        opts?: { force?: boolean; reset?: boolean },
      ): { x: number; y: number; z: number };
    };
    const origConstrainCam = camEditor.getConstrainedCamera.bind(editor);
    camEditor.getConstrainedCamera = (point, opts) => {
      let { x, y, z } = point;
      // Zoom stops are applied HERE, before the region shift. When the
      // requested z is past a zoom limit, tldraw's stop IGNORES the passed
      // point and re-derives x/y from the live camera — a page-space value,
      // so the -camRegion unshift below would subtract an offset that was
      // never added, walking the camera by -camRegion on every blocked
      // wheel tick (the map crept diagonally when zooming past min/max).
      // Pre-stopped the same way upstream does it — z halts, the viewport
      // centre stays put — the original only ever sees in-range z and maps
      // point -> point, which the shift/unshift conjugates exactly.
      if (!opts?.force && z !== undefined) {
        const cam = editor.getCamera();
        const steps = editor.getCameraOptions().zoomSteps;
        const base = editor.getBaseZoom();
        const minZ = steps[0] * base;
        const maxZ = steps[steps.length - 1] * base;
        if (z < minZ || z > maxZ) {
          const vsb = editor.getViewportScreenBounds();
          z = Math.min(Math.max(z, minZ), maxZ);
          x = cam.x + vsb.w / 2 / z - vsb.w / 2 / cam.z;
          y = cam.y + vsb.h / 2 / z - vsb.h / 2 / cam.z;
        }
      }
      const local = origConstrainCam(
        { ...point, x: x + camRegion.x, y: y + camRegion.y, z },
        opts,
      );
      return { ...local, x: local.x - camRegion.x, y: local.y - camRegion.y };
    };
    const updateCameraConstraints = () => {
      const b = editor.getCurrentPageBounds();
      if (!b || b.w < 1 || b.h < 1) return;
      const prev = editor.getCameraOptions().constraints;
      if (
        prev &&
        Math.abs(camRegion.x - b.x) < 1 &&
        Math.abs(camRegion.y - b.y) < 1 &&
        Math.abs(prev.bounds.w - b.w) < 1 &&
        Math.abs(prev.bounds.h - b.h) < 1
      ) {
        return; // unchanged — skip the options churn
      }
      camRegion.x = b.x;
      camRegion.y = b.y;
      editor.setCameraOptions({
        constraints: {
          bounds: { x: 0, y: 0, w: b.w, h: b.h },
          padding: { x: 128, y: 128 },
          origin: { x: 0.5, y: 0.5 },
          initialZoom: "fit-max",
          baseZoom: "default",
          behavior: "outside",
        },
      });
    };
    updateCameraConstraintsRef.current = updateCameraConstraints;

    // Multi-selection drags: tldraw snaps the selection BOX — point snaps use
    // its corners+centre and gap snaps its borders — rather than the shapes
    // inside it. No hook exists, so wrap snapTranslateShapes: substitute the
    // selected stations' initial marker centres as the dragged snap points
    // (every member then snaps in line against the stations outside the
    // selection, like a lone drag), and suppress gap snapping for the call —
    // its box-border semantics is exactly the reported confusion, and
    // equal-spacing against a whole moving group has no member-wise meaning.
    // Mixed/single selections keep the default behaviour.
    {
      const sb = editor.snaps.shapeBounds;
      const origSnapTranslate = sb.snapTranslateShapes.bind(sb);
      type TranslateArgs = Parameters<typeof sb.snapTranslateShapes>[0];
      const gapless = sb as unknown as {
        getVisibleGaps?: () => { horizontal: never[]; vertical: never[] };
      };
      sb.snapTranslateShapes = (args: TranslateArgs) => {
        const translating = editor.getStateDescendant(
          "select.translating",
        ) as unknown as
          | {
              snapshot?: {
                shapeSnapshots?: {
                  shape: { type: string; props: { w: number; h: number } };
                  pagePoint: { x: number; y: number };
                }[];
              };
            }
          | undefined;
        const snaps = translating?.snapshot?.shapeSnapshots;
        if (
          !snaps ||
          snaps.length < 2 ||
          !snaps.every((s) => s.shape.type === "station")
        ) {
          return origSnapTranslate(args);
        }
        gapless.getVisibleGaps = () => ({ horizontal: [], vertical: [] });
        try {
          return origSnapTranslate({
            ...args,
            initialSelectionSnapPoints: snaps.map((s, i) => ({
              id: `selection:${i}`,
              x: s.pagePoint.x + s.shape.props.w / 2,
              y: s.pagePoint.y + s.shape.props.h / 2,
            })),
          });
        } finally {
          // Remove the instance shadow so the prototype's computed gap
          // discovery resumes for single-station drags.
          delete gapless.getVisibleGaps;
        }
      };
    }

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
          const acc: ShapePartial[] = [];
          for (const shape of editor.getCurrentPageShapes()) {
            if (shape.type !== "tube-line" || shape.props.core) continue;
            const ids = shape.props.stationIds as TLShapeId[];
            // Dragging only happens in editable mode → octilinear connectors.
            if (ids.includes(next.id)) {
              buildLinePartials(
                acc,
                editor,
                shape,
                null,
                true,
                coreIdForRef.current.get(shape.id),
              );
              affected.add(shape.id);
            }
          }
          if (acc.length) editor.updateShapes(acc);
          geomGenRef.current++; // line geometry moved — dwell headings stale
          if (affected.size) positionTrains(affected);
          // Station moved -> label overlaps may change, and the camera-
          // constraint region moves with the content (getCurrentPageBounds is
          // invalidated by EVERY shape change — trains tick at 10Hz — so each
          // call re-folds ~1,500 shape bounds; per pointer-move was pure
          // waste). Both are throttled together (leading edge keeps the
          // edge-scroll frontier growing mid-drag) with a trailing debounce
          // so the drag's FINAL position always gets a recompute. They run
          // AFTER the line redraw above, so an inward move sees the shrunk
          // lines too, not their stale extent.
          const t = performance.now();
          if (t - lastDeclutter.current > 150) {
            lastDeclutter.current = t;
            recomputeLabelDeclutter(editor);
            updateCameraConstraints();
          } else {
            if (declutterTimer.current !== null)
              clearTimeout(declutterTimer.current);
            declutterTimer.current = setTimeout(() => {
              declutterTimer.current = null;
              lastDeclutter.current = performance.now();
              recomputeLabelDeclutter(editor);
              updateCameraConstraints();
            }, 180);
          }
        },
        { ignoreShapeLock: true },
      );
    });

    const fit = () => {
      const vp = editor.getViewportScreenBounds();
      if (!vp || vp.w < 1 || vp.h < 1) {
        requestAnimationFrame(fit);
        return;
      }
      // Shapes exist by now — take the first constraint measurement.
      updateCameraConstraints();
      editor.zoomToFit();
      // A phone fits the whole network into a sliver — start closer in,
      // centred on the same spot, and let the user pan out for the edges.
      if (vp.w <= 640) {
        const cam = editor.getCamera();
        const z = cam.z * 1.5;
        const c = editor.getViewportPageBounds().center;
        editor.setCamera({ x: vp.w / 2 / z - c.x, y: vp.h / 2 / z - c.y, z });
      }
    };
    requestAnimationFrame(fit);

    editorRef.current = editor;
  }, [positionTrains]);

  // Animate stations to the target layout (and follow with the lines).
  const applyMode = useCallback((editor: Editor, geo: boolean) => {
    if (animFrame.current !== null) cancelAnimationFrame(animFrame.current);
    if (settleExtras.current !== null) {
      cancelAnimationFrame(settleExtras.current);
      settleExtras.current = null;
    }

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
      .filter(
        (s): s is TubeLineShape => s.type === "tube-line" && !s.props.core,
      )
      .map((s) => ({
        id: s.id,
        coreId: coreIdForRef.current.get(s.id),
        stationIds: s.props.stationIds as TLShapeId[],
        // Tween frames blend THINNED profiles (trains and the settle pass
        // stay full-resolution). Zoomed out, the whole network is in view
        // and must be computed every frame — but a 3-unit deviation is only
        // ~0.3 screen px there, so the coarser level carries the load;
        // zoomed in, detail matters but S5's viewport scoping below means
        // only the visible few lines are computed at all.
        segMorph:
          (editor.getZoomLevel() < TWEEN_COARSE_ZOOM
            ? segProfilesCoarserRef.current.get(s.id)
            : segProfilesCoarseRef.current.get(s.id)) ?? [],
        // Conservative bbox for every mid-tween frame of this line: each
        // blended point is a lerp of octilinear and curve components, both
        // bounded by (start-path bbox ∪ end-path bbox) expanded by the
        // profile's max perpendicular excursion — cheap to test against the
        // live viewport each frame, so off-screen lines skip geometry AND
        // writes entirely (positions are absolute; the settle pass trues
        // everything network-wide).
        bbox: null as null | { x0: number; y0: number; x1: number; y1: number },
      }));

    // Only animate stations that actually move (none, in the common no-edit
    // case) — keeps the whole-network tween cheap.
    const movingIds = ids.filter((id) => {
      const s = starts.get(id)!;
      const g = targets.get(id)!;
      return Math.abs(s.x - g.x) > 0.5 || Math.abs(s.y - g.y) > 0.5;
    });

    // Tween-pose map: every station's centre, updated in plain JS per frame
    // (only movingIds entries ever change). The line loop reads it instead of
    // stationCentre() — those read-backs were ~4,000 getShapePageTransform
    // calls per morph frame — and it's what makes batching the frame's writes
    // possible at all: lines drawn AFTER batched station writes would
    // otherwise see the previous frame's centres.
    const centres = new Map<TLShapeId, Pt>();
    for (const id of ids) {
      const c = stationCentre(editor, id);
      if (c) centres.set(id, c);
    }
    // A station's top-left delta equals its centre delta (fixed marker size),
    // so per frame each moving centre is startCentre + (target - start) * e —
    // the same interpolant as the shape write below.
    const startCentres = new Map<TLShapeId, Pt>();
    for (const id of movingIds) {
      const c = centres.get(id);
      if (c) startCentres.set(id, { x: c.x, y: c.y });
    }

    // Per-line tween bbox (S5): every blended point is a lerp of an
    // octilinear component (contained in its endpoints' AABB — the elbow and
    // its fillet never leave the rectangle) and a curve component (chord
    // point + perp excursion), with endpoints travelling start→target. So
    // AABB(all start ∪ target centres) grown by max(|perp|·chord) bounds
    // every frame of the tween.
    for (const lm of lineMorph) {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      let ok = true;
      const centrePts: Pt[] = [];
      for (const id of lm.stationIds) {
        const c = centres.get(id);
        if (!c) {
          ok = false;
          break;
        }
        centrePts.push(c);
        const s = starts.get(id);
        const g = targets.get(id);
        const tx = s && g ? c.x + (g.x - s.x) : c.x;
        const ty = s && g ? c.y + (g.y - s.y) : c.y;
        if (c.x < x0) x0 = c.x;
        if (c.x > x1) x1 = c.x;
        if (c.y < y0) y0 = c.y;
        if (c.y > y1) y1 = c.y;
        if (tx < x0) x0 = tx;
        if (tx > x1) x1 = tx;
        if (ty < y0) y0 = ty;
        if (ty > y1) y1 = ty;
      }
      if (!ok) continue; // missing centre — never skip this line
      let margin = 20; // fillet arcs + rounding slack
      for (let i = 0; i < centrePts.length - 1; i++) {
        const prof = lm.segMorph[i];
        if (!prof) continue;
        let maxPerp = 0;
        for (const p of prof.perp) {
          const a = Math.abs(p);
          if (a > maxPerp) maxPerp = a;
        }
        const chord = Math.hypot(
          centrePts[i + 1].x - centrePts[i].x,
          centrePts[i + 1].y - centrePts[i].y,
        );
        const exc = maxPerp * chord * 1.1; // stations drift the chord a bit
        if (exc > margin) margin = exc;
      }
      lm.bbox = {
        x0: x0 - margin,
        y0: y0 - margin,
        x1: x1 + margin,
        y1: y1 + margin,
      };
    }

    animating.current = true;
    let startTs: number | null = null;

    // Tween frames only: round path points to 2 decimals (≤0.014px error,
    // invisible) — full-precision floats tripled the d string length, and the
    // string build + browser path parse are per-frame costs. The settle pass
    // does NOT round, keeping settled geometry byte-identical to before.
    const r2 = (v: number) => Math.round(v * 100) / 100;

    const tick = (now: number) => {
      if (startTs === null) startTs = now;
      const t = Math.min(1, (now - startTs) / ANIM_MS);
      const e = easeInOutCubic(t);
      const tickStart = performance.now();
      // Viewport gate (S5): tween frames only compute and write shapes whose
      // tween bbox can intersect the (expanded) viewport — off-screen work is
      // invisible and the settle pass trues the whole network. The FINAL
      // frame writes everything so no shape is left short of its target.
      const finalFrame = t >= 1;
      const vp = editor.getViewportPageBounds();
      const vpApron = Math.max(vp.w, vp.h) * 0.25;
      const vx0 = vp.x - vpApron;
      const vy0 = vp.y - vpApron;
      const vx1 = vp.x + vp.w + vpApron;
      const vy1 = vp.y + vp.h + vpApron;
      // ONE batched write for the whole frame — stations, casings and core
      // twins together. 365 per-shape updateShape calls cost ~14.5ms/frame in
      // call overhead alone.
      const partials: ShapePartial[] = [];
      for (const id of movingIds) {
        const s = starts.get(id)!;
        const g = targets.get(id)!;
        // The centres map must track EVERY moving station each frame (lines
        // and trains read it) — only the shape WRITE is viewport-gated.
        const c0 = startCentres.get(id);
        const c = centres.get(id);
        if (c0 && c) {
          c.x = c0.x + (g.x - s.x) * e;
          c.y = c0.y + (g.y - s.y) * e;
        }
        if (!finalFrame && c0) {
          // Whole travel segment (start→target centre) off the expanded
          // viewport → the write is invisible this frame.
          const lox = Math.min(c0.x, c0.x + (g.x - s.x));
          const hix = Math.max(c0.x, c0.x + (g.x - s.x));
          const loy = Math.min(c0.y, c0.y + (g.y - s.y));
          const hiy = Math.max(c0.y, c0.y + (g.y - s.y));
          if (hix < vx0 || lox > vx1 || hiy < vy0 || loy > vy1) continue;
        }
        partials.push({
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
      morphCentresRef.current = centres; // ...and read the same centres
      for (const lm of lineMorph) {
        // The settle branch below redraws every line at full resolution in
        // this very callback — a coarse final-frame pass would be duplicate.
        if (finalFrame) break;
        if (
          !finalFrame &&
          lm.bbox &&
          (lm.bbox.x1 < vx0 ||
            lm.bbox.x0 > vx1 ||
            lm.bbox.y1 < vy0 ||
            lm.bbox.y0 > vy1)
        ) {
          continue; // whole tween stays off-screen — settle trues it
        }
        const lmCentres: Pt[] = [];
        for (const id of lm.stationIds) {
          const c = centres.get(id);
          if (c) lmCentres.push(c);
        }
        if (lmCentres.length < 2) continue;
        let pts: Pt[];
        if (lmCentres.length === lm.stationIds.length) {
          pts = [];
          for (let i = 0; i < lmCentres.length - 1; i++) {
            const segPts = morphSegmentPoints(
              lmCentres[i],
              lmCentres[i + 1],
              lm.segMorph[i] ?? null,
              morphFrac,
            );
            for (let k = 0; k < segPts.length; k++) {
              // Drop each segment's first point — it is the previous
              // segment's shared station endpoint.
              if (i > 0 && k === 0) continue;
              const p = segPts[k];
              p.x = r2(p.x);
              p.y = r2(p.y);
              pts.push(p);
            }
          }
        } else {
          // Some stations missing → octilinear through what we have.
          pts = octilinearPoints(lmCentres);
        }
        pushLinePartials(partials, lm.id, pathFromPoints(pts), lm.coreId);
      }
      editor.run(
        () => {
          editor.updateShapes(partials);
        },
        { ignoreShapeLock: true },
      );
      // Re-pose the visible trains on the freshly drawn morph frame — the
      // ambient ~10fps tick would let them visibly lag the 60fps line tween.
      // The tween flavor early-skips off-screen trains and leaves
      // create/delete to the ambient full pass (which keeps running).
      positionTrains(undefined, false, true);
      {
        const p = debugPerfRef.current;
        const spent = performance.now() - tickStart;
        p.morphMs = p.morphMs ? p.morphMs * 0.9 + spent * 0.1 : spent;
      }
      if (t < 1) {
        animFrame.current = requestAnimationFrame(tick);
      } else {
        animFrame.current = null;
        animating.current = false;
        morphFracRef.current = geo ? 1 : 0;
        morphCentresRef.current = null; // settled — live centre reads resume
        geomGenRef.current++; // new layout — dwell headings stale
        // Settle: geographic snaps lines onto the real OSM track curves;
        // editable settles onto octilinear connectors.
        recomputeAllLines(
          editor,
          geo ? lineGeo.current : null,
          !geo,
          coreIdForRef.current,
        );
        editor.updateInstanceState({ isReadonly: geo });
        positionTrains();
        // The label declutter (greedy O(n²) over 505 labels) and the camera
        // constraint re-measure (full page-bounds fold) ran here in the SAME
        // frame as the settle redraw — a visible ~2x frame spike right at the
        // morph's end. The settle pixels are already final (F3: the tween at
        // frac 1/0 reproduces the rest geometry), labels cross-fade over
        // 150ms and one frame of a stale camera clamp is unobservable, so
        // both defer to the next frame. Cancelled at the top of applyMode
        // and guarded on `animating` so a double-toggle mid-morph can't run
        // stale settle work against the NEW tween.
        settleExtras.current = requestAnimationFrame(() => {
          settleExtras.current = null;
          if (animating.current) return;
          recomputeLabelDeclutter(editor); // layout changed with the mode
          // The two layouts span different extents — re-measure the camera
          // constraints now that the morph has settled.
          updateCameraConstraintsRef.current?.();
        });
      }
    };
    animFrame.current = requestAnimationFrame(tick);
  }, [positionTrains]);

  // Animate only on a real mode change — skip the initial mount (and React
  // strict-mode's double-invoke), which would otherwise run a no-op animation.
  const lastMode = useRef(false);
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || lastMode.current === geoMode) return;
    lastMode.current = geoMode;
    applyMode(editor, geoMode);
  }, [geoMode, applyMode]);

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
      // ONE request for every TfL line: /Line/{ids}/Arrivals accepts a comma
      // list. Per-line requests burst 20 upstream fetches per poll, which
      // exceeds TfL's anonymous rate budget (~12/min measured) and got whole
      // lines 429-dropped. National Rail lines (Thameslink) aren't served by
      // TfL at all — they come from the Darwin-backed /api/rail proxy in the
      // same Prediction shape, fetched in parallel and merged. `no-store`
      // skips the browser HTTP cache — one less layer of staleness.
      const tflIds = lineIds.filter((id) => !NR_LINE_IDS.has(id));
      const hasRail = lineIds.some((id) => NR_LINE_IDS.has(id));
      try {
        const [res, railRes, statusRes] = await Promise.all([
          fetch(`/api/tfl/Line/${tflIds.join(",")}/Arrivals`, {
            signal,
            cache: "no-store",
          }),
          hasRail
            ? fetch(`/api/rail/arrivals`, { signal, cache: "no-store" }).catch(
                () => null,
              )
            : Promise.resolve(null),
          // Line status rides along to gate ghost trains: TfL's countdown
          // system keeps emitting Arrivals for CLOSED lines (stabled trains
          // parked at platforms under dummy vehicle ids, plus schedule-seeded
          // phantoms — verified: 76 jubilee predictions at "Service Closed").
          // ALL line ids, not just TfL ones — TfL serves status for
          // Thameslink too, so NR lines gate and dim the same way. A status
          // failure fails OPEN (no gating) — worst case is ghosts, never
          // missing real trains.
          fetch(`/api/tfl/Line/${lineIds.join(",")}/Status`, {
            signal,
            cache: "no-store",
          }).catch(() => null),
        ]);
        const dbg = debugPollRef.current;
        dbg.tflOk = res.ok;
        if (!res.ok) return; // keep the old store — trajectories cover the gap
        let preds = (await res.json()) as Prediction[];
        dbg.tflPreds = preds.length;
        // A rail-side failure shouldn't sink the TfL lines; NR records are
        // carried over from the previous store below so their trains keep
        // walking their trajectories instead of vanishing for a poll.
        const railOk = railRes !== null && railRes.ok;
        dbg.railStatus = hasRail ? (railOk ? "ok" : "FAILED") : "off";
        if (railOk) {
          const railPreds = (await railRes.json()) as Prediction[];
          dbg.railSource = railRes.headers.get("x-rail-source") ?? "?";
          dbg.railPreds = railPreds.length;
          preds = preds.concat(railPreds);
        }
        // A line is gated only when EVERY one of its statuses is a full
        // closure — mixed states (part closure + minor delays, part
        // suspended) still run real trains on the unaffected sections.
        const closed = new Set<string>();
        if (statusRes?.ok) {
          try {
            const statuses = (await statusRes.json()) as LineStatus[];
            for (const l of statuses) {
              if (
                l.lineStatuses.length > 0 &&
                l.lineStatuses.every((s) =>
                  CLOSED_SEVERITIES.has(s.statusSeverity),
                )
              ) {
                closed.add(l.id);
              }
            }
          } catch {
            // unparseable status — fail open
          }
        }
        // Publish the raw set; lib/tube/status layers any debug-panel
        // overrides on top, change-checks the atoms, and derives the
        // closed-station set. Gating below uses the EFFECTIVE set so a
        // forced closure also parks that line's trains.
        publishPolledClosures(closed);
        const gated = closedLines.get();
        dbg.closedLines = [...gated];
        if (cancelled || signal.aborted) return;
        const fetchMs = Date.now();
        dbg.lastPollMs = fetchMs;
        const byLine = new Map<string, Prediction[]>();
        for (const p of preds) {
          if (gated.has(p.lineId)) continue; // ghost trains on a closed line
          const list = byLine.get(p.lineId);
          if (list) list.push(p);
          else byLine.set(p.lineId, [p]);
        }
        const next = new Map<string, TrainRecord>();
        if (hasRail && !railOk) {
          for (const [key, rec] of trainStore.current) {
            if (NR_LINE_IDS.has(rec.lineId)) next.set(key, rec);
          }
        }
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
              // Continuity: seeds each vehicle's coherent ladder chain and
              // breaks branch-resolution ties toward last poll's placement.
              trainStore.current,
            ),
          );
          for (const r of recs) next.set(r.key, r);
        }
        // NR retention: staff DEPARTURE boards drop a service once it leaves
        // its last polled board station, but its record already carries the
        // full remaining route with times — keep it walking to the
        // trajectory's end (plus a grace minute) instead of vanishing
        // mid-run on its final, board-less stretch.
        if (hasRail && railOk) {
          for (const [key, rec] of trainStore.current) {
            if (!NR_LINE_IDS.has(rec.lineId) || next.has(key)) continue;
            if (gated.has(rec.lineId)) continue; // closure purges retention
            const last = rec.steps[rec.steps.length - 1];
            if (last && last.endMs > fetchMs - 60_000) next.set(key, rec);
          }
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

    // Refresh immediately on tab return: the interval is throttled while
    // hidden, and the post-wake resync window wants fresh data right away
    // rather than up to TRAIN_POLL_MS later.
    const onVisible = () => {
      if (document.visibilityState === "visible") poll();
    };
    document.addEventListener("visibilitychange", onVisible);

    // A debug-panel status override should re-gate trains immediately, not
    // up to TRAIN_POLL_MS later (dimming is instant either way — the shapes
    // read the atoms). react() runs once up front to capture the dependency;
    // skip that initial call.
    let overridesSeen = lineOverridesRev.get();
    const stopOverrideReact = react("re-poll on line override", () => {
      const rev = lineOverridesRev.get();
      if (rev === overridesSeen) return;
      overridesSeen = rev;
      poll();
    });

    return () => {
      cancelled = true;
      ac?.abort();
      if (iv) clearInterval(iv);
      if (retry) clearTimeout(retry);
      stopOverrideReact();
      document.removeEventListener("visibilitychange", onVisible);
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
      // Read-only views of the live train state, for diagnosing position
      // anomalies in situ (the refs are REPLACED on poll, hence getters).
      (
        window as unknown as { __trainDebug?: Record<string, () => unknown> }
      ).__trainDebug = {
        store: () => trainStore.current,
        render: () => trainRender.current,
        shapes: () => trainShapes.current,
      };
    }
    let raf: number | null = null;
    let lastFull = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      debugPerfRef.current.frames++;
      const now = performance.now();
      if (now - lastFull >= TRAIN_TICK_MS) {
        lastFull = now;
        positionTrains();
      } else if (!animating.current) {
        // Mid-morph the tick runs its own per-frame tween pass — an ambient
        // fine pass on the same frame would be pure duplicate work. The 10Hz
        // full pass above stays on: it owns create/delete and trues trains
        // that sweep on-screen past the tween pass's apron.
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

  // Debug-panel snapshot: cheap reads over the live refs, taken at 1Hz while
  // the panel is open (DebugPanel drives the interval).
  const collectDebugStats = useCallback((): DebugStats | null => {
    const editor = editorRef.current;
    if (!editor) return null;
    const nowEpoch = Date.now();
    const nowPerf = performance.now();
    const store = trainStore.current;
    const render = trainRender.current;
    const dbgPoll = debugPollRef.current;
    const perf = debugPerfRef.current;

    const vp = editor.getViewportPageBounds();
    const onScreen = (x: number, y: number) =>
      x >= vp.x - 50 &&
      x <= vp.x + vp.w + 50 &&
      y >= vp.y - 50 &&
      y <= vp.y + vp.h + 50;

    let trainsOnScreen = 0;
    let offSum = 0;
    let offMax = 0;
    let glides = 0;
    let glideMax = 0;
    for (const rs of render.values()) {
      if (onScreen(rs.x, rs.y)) trainsOnScreen++;
      const off = Math.abs(rs.springO);
      offSum += off;
      if (off > offMax) offMax = off;
      const dt = (nowPerf - rs.offStart) / rs.blendMs;
      if (dt < 1 && (rs.offX !== 0 || rs.offY !== 0)) {
        glides++;
        const g = Math.hypot(rs.offX, rs.offY);
        if (g > glideMax) glideMax = g;
      }
    }

    const byLineMap = new Map<string, number>();
    for (const rec of store.values())
      byLineMap.set(rec.lineId, (byLineMap.get(rec.lineId) ?? 0) + 1);
    const byLine = [...byLineMap.entries()].sort((a, b) => b[1] - a[1]);

    let stationsTotal = 0;
    let casings = 0;
    let cores = 0;
    for (const s of editor.getCurrentPageShapes()) {
      if (s.type === "station") stationsTotal++;
      else if (s.type === "tube-line") {
        if ((s as TubeLineShape).props.core) cores++;
        else casings++;
      }
    }
    let stationsCulled = 0;
    let trainsCulled = 0;
    for (const id of editor.getCulledShapes()) {
      const t = editor.getShape(id)?.type;
      if (t === "station") stationsCulled++;
      else if (t === "train") trainsCulled++;
    }

    const hidden = hiddenLabels.get();

    // FPS from the rAF frame counter, measured since the previous snapshot.
    const dtS = perf.prevAt ? (nowPerf - perf.prevAt) / 1000 : 0;
    const fps = dtS > 0 ? (perf.frames - perf.prevFrames) / dtS : 0;
    perf.prevFrames = perf.frames;
    perf.prevAt = nowPerf;

    return {
      poll: {
        agoS: dbgPoll.lastPollMs
          ? (nowEpoch - dbgPoll.lastPollMs) / 1000
          : null,
        everyS: TRAIN_POLL_MS / 1000,
        tflOk: dbgPoll.tflOk,
        tflPreds: dbgPoll.tflPreds,
        railSource: dbgPoll.railSource,
        railStatus: dbgPoll.railStatus,
        railPreds: dbgPoll.railPreds,
        closedLines: dbgPoll.closedLines,
        lineStates: [...branchesForLineRef.current.keys()].map((id) => ({
          id,
          closed: closedLines.get().has(id),
          forced: getLineOverride(id) !== null,
        })),
      },
      trains: {
        records: store.size,
        shapes: trainShapes.current.size,
        onScreen: trainsOnScreen,
        culled: trainsCulled,
        byLine,
      },
      drift: {
        meanOffMs: render.size ? offSum / render.size : 0,
        maxOffMs: offMax,
        glides,
        maxGlidePx: glideMax,
        resyncActive: nowEpoch < resyncUntilRef.current,
      },
      stations: {
        total: stationsTotal,
        culled: stationsCulled,
        labelsHiddenAll: hidden.all.size,
        labelsHiddenInter: hidden.interOnly.size,
      },
      lines: { casings, cores },
      perf: {
        fps,
        fullMs: perf.fullMs,
        fineMs: perf.fineMs,
        morphMs: perf.morphMs,
      },
      camera: {
        zoom: editor.getZoomLevel(),
        mode: geoMode ? "geographic" : "editable",
        morph: morphFracRef.current,
      },
    };
  }, [geoMode]);

  if (!mounted) return null;

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div className="mode-toggle" role="group" aria-label="Map layout mode">
        <button
          type="button"
          className={!geoMode ? "active" : undefined}
          aria-pressed={!geoMode}
          onClick={() => setGeoMode(false)}
        >
          Editable
        </button>
        <button
          type="button"
          className={geoMode ? "active" : undefined}
          aria-pressed={geoMode}
          onClick={() => setGeoMode(true)}
        >
          Geographic
        </button>
      </div>
      <DebugPanel collect={collectDebugStats} />
      <Tldraw
        shapeUtils={shapeUtils}
        hideUi
        options={tldrawOptions}
        onMount={handleMount}
      />
    </div>
  );
}
