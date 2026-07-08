"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
import { hiddenLabels } from "@/lib/tube/labels";
import { isHollowLine, isNationalRailLine } from "@/lib/tfl/lines";
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
  const path = pathFromPoints(pts);
  editor.updateShape<TubeLineShape>({
    id: line.id,
    type: "tube-line",
    x: path.x,
    y: path.y,
    props: { w: path.w, h: path.h, d: path.d },
  });
  // A hollow fragment's white core rides along as a twin shape: mirror the
  // computed path instead of recomputing it.
  if (coreId) {
    editor.updateShape<TubeLineShape>({
      id: coreId,
      type: "tube-line",
      x: path.x,
      y: path.y,
      props: { w: path.w, h: path.h, d: path.d },
    });
  }
}

/**
 * Redraw every line. Pass `lineGeo` to draw OSM curves where available; lines
 * without a curve fall back to `octi` octilinear (editable) or straight chords.
 * Core twins are never recomputed directly — they mirror their casing.
 */
function recomputeAllLines(
  editor: Editor,
  lineGeo: Map<TLShapeId, Pt[]> | null,
  octi: boolean,
  coreIdFor: ReadonlyMap<TLShapeId, TLShapeId>,
) {
  editor.run(
    () => {
      for (const shape of editor.getCurrentPageShapes()) {
        if (shape.type === "tube-line" && !shape.props.core) {
          recomputeLine(
            editor,
            shape,
            lineGeo?.get(shape.id) ?? null,
            octi,
            coreIdFor.get(shape.id),
          );
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
  const lastDeclutter = useRef(0);
  const declutterTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Wall-clock of the last positioning pass + the post-wake snap window. */
  const lastPassRef = useRef(0);
  const resyncUntilRef = useRef(0);
  /** Hollow casing shape id -> its white-core twin (mirrors the casing's path). */
  const coreIdForRef = useRef<Map<TLShapeId, TLShapeId>>(new Map());

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

    editor.createShapes<TubeLineShape | StationShape>([
      ...lineShapes,
      ...stationShapes,
    ]);
    recomputeLabelDeclutter(editor);

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

    // Camera constraints: the viewport can never lose the map. With
    // 'outside', the network bounds must always stay touching the viewport
    // inset by the padding — so at least ~130 screen px of map remains
    // visible however far you pan or zoom. The bounds sit exactly on the
    // network (the projection starts at 0,0): tldraw's 'outside' clamp
    // ignores bounds.x/y (it anchors the region at the origin), so any
    // margin baked into the bounds would just let the map escape by that
    // much on one side and over-restrict the other. Edge-scrolling while
    // dragging a selection pans through this same constrained camera, so it
    // keeps working, just not past the limit.
    editor.setCameraOptions({
      constraints: {
        bounds: { x: 0, y: 0, w: net.bounds.w, h: net.bounds.h },
        padding: { x: 128, y: 128 },
        origin: { x: 0.5, y: 0.5 },
        initialZoom: "fit-max",
        baseZoom: "default",
        behavior: "outside",
      },
    });

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
          for (const shape of editor.getCurrentPageShapes()) {
            if (shape.type !== "tube-line" || shape.props.core) continue;
            const ids = shape.props.stationIds as TLShapeId[];
            // Dragging only happens in editable mode → octilinear connectors.
            if (ids.includes(next.id)) {
              recomputeLine(
                editor,
                shape,
                null,
                true,
                coreIdForRef.current.get(shape.id),
              );
              affected.add(shape.id);
            }
          }
          if (affected.size) positionTrains(affected);
          // Station moved -> label overlaps may change. Throttled (this fires
          // per pointer move) with a trailing debounce so the drag's FINAL
          // position always gets a recompute.
          const t = performance.now();
          if (t - lastDeclutter.current > 150) {
            lastDeclutter.current = t;
            recomputeLabelDeclutter(editor);
          } else {
            if (declutterTimer.current !== null)
              clearTimeout(declutterTimer.current);
            declutterTimer.current = setTimeout(() => {
              declutterTimer.current = null;
              lastDeclutter.current = performance.now();
              recomputeLabelDeclutter(editor);
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
      .filter(
        (s): s is TubeLineShape => s.type === "tube-line" && !s.props.core,
      )
      .map((s) => ({
        id: s.id,
        coreId: coreIdForRef.current.get(s.id),
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
            // Mirror the frame's path to the white-core twin (no recompute).
            if (lm.coreId) {
              editor.updateShape<TubeLineShape>({
                id: lm.coreId,
                type: "tube-line",
                x: path.x,
                y: path.y,
                props: { w: path.w, h: path.h, d: path.d },
              });
            }
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
        recomputeAllLines(
          editor,
          geo ? lineGeo.current : null,
          !geo,
          coreIdForRef.current,
        );
        editor.updateInstanceState({ isReadonly: geo });
        positionTrains();
        recomputeLabelDeclutter(editor); // layout changed with the mode
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
      const vpX0 = vp.x - 50;
      const vpY0 = vp.y - 50;
      const vpX1 = vp.x + vp.w + 50;
      const vpY1 = vp.y + vp.h + 50;
      const onScreen = (px: number, py: number) =>
        px >= vpX0 && px <= vpX1 && py >= vpY0 && py <= vpY1;

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
        const cA = stationCentre(editor, idA);
        const cB = stationCentre(editor, idB);
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
        // Fine passes smooth what's already on screen; initialisation and
        // newly-visible trains belong to the 10Hz full pass.
        if (fine && (!rs || !onScreen(rs.x, rs.y))) continue;
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
        // Heading: smooth the displayed rotation toward the target tangent
        // (shortest arc, tau ~120ms) so reversals and departures swing over
        // ~0.4s instead of snapping. A dwelling on-screen train aims at its
        // DEPARTURE tangent (probe the trajectory ahead), turning on the
        // platform before it moves.
        let targetRot = Math.atan2(placed.tangent.y, placed.tangent.x);
        if (settled && !pose.moving && onScreen(dispX, dispY)) {
          for (const k of HEADING_PROBES) {
            const fut = trainPose(rec, dispTime + k);
            if (!fut) break;
            if (fut.moving) {
              const fp = placedFor(fut);
              if (fp) targetRot = Math.atan2(fp.tangent.y, fp.tangent.x);
              break;
            }
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
              // Continuity: seeds each vehicle's coherent ladder chain and
              // breaks branch-resolution ties toward last poll's placement.
              trainStore.current,
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

    // Refresh immediately on tab return: the interval is throttled while
    // hidden, and the post-wake resync window wants fresh data right away
    // rather than up to TRAIN_POLL_MS later.
    const onVisible = () => {
      if (document.visibilityState === "visible") poll();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      ac?.abort();
      if (iv) clearInterval(iv);
      if (retry) clearTimeout(retry);
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
      <Tldraw shapeUtils={shapeUtils} hideUi onMount={handleMount} />
    </div>
  );
}
