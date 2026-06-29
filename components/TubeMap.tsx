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
import { getTubeNetwork } from "@/lib/tube/network";
import { selectStation } from "@/lib/tube/selection";

const shapeUtils = [TubeLineShapeUtil, StationShapeUtil];
const MARKER = 11;
const ANIM_MS = 650;

// Line ids to show — null shows the whole network.
const SHOWN_LINES: string[] | null = null;

type Pt = { x: number; y: number };
type Pose = { x: number; y: number; rotation: number };
/**
 * A segment's OSM curve decomposed along/perpendicular to its geo chord, plus
 * each point's normalised arc-length (0..1) — the monotonic parameter that maps
 * curve points onto the octilinear connector during the morph.
 */
type SegProfile = { along: number[]; perp: number[]; arc: number[] };

const easeInOutCubic = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

/** Build an SVG path + bounding box from page-space points (station centres). */
function pathFromPoints(points: Pt[]) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const d = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x - minX} ${p.y - minY}`)
    .join(" ");
  return {
    x: minX,
    y: minY,
    w: Math.max(...xs) - minX || 1,
    h: Math.max(...ys) - minY || 1,
    d,
  };
}

/** Current page-space centre of a station shape, if it exists. */
function stationCentre(editor: Editor, id: TLShapeId): Pt | null {
  const b = editor.getShapePageBounds(id);
  return b ? { x: b.center.x, y: b.center.y } : null;
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

/** Octilinear polyline through `centres` — a 135° bend inserted per pair. */
function octilinearPoints(centres: Pt[]): Pt[] {
  if (centres.length < 2) return centres.slice();
  const out: Pt[] = [centres[0]];
  for (let i = 1; i < centres.length; i++) {
    const bend = octiBend(centres[i - 1], centres[i]);
    if (bend) out.push(bend);
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
  const bend = octiBend(cA, cB);
  // The bend's own arc-length fraction along the two-leg octilinear connector.
  const leg1 = bend ? Math.hypot(bend.x - cA.x, bend.y - cA.y) : 0;
  const leg2 = bend ? Math.hypot(cB.x - bend.x, cB.y - bend.y) : 0;
  const aBend = bend && leg1 + leg2 > 1e-6 ? leg1 / (leg1 + leg2) : 0;
  // The octilinear connector evaluated at arc-length fraction a (0..1).
  const octiAt = (a: number): Pt => {
    if (!bend) return { x: cA.x + a * cx, y: cA.y + a * cy };
    if (a <= aBend) {
      const f = aBend > 1e-6 ? a / aBend : 0;
      return { x: cA.x + (bend.x - cA.x) * f, y: cA.y + (bend.y - cA.y) * f };
    }
    const f = aBend < 1 - 1e-6 ? (a - aBend) / (1 - aBend) : 0;
    return { x: bend.x + (cB.x - bend.x) * f, y: bend.y + (cB.y - bend.y) * f };
  };
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
  const out: Pt[] = [];
  let injected = !bend; // with a bend, inject its sharp vertex exactly once
  for (let j = 0; j < along.length; j++) {
    if (!injected && arc[j] > aBend) {
      // Inject the bend at its arc-length fraction: the 135° corner is sharp at
      // morphFrac 0 and sits on the curve (collinear, invisible) at morphFrac 1.
      const prev = arc[j - 1];
      const f = (aBend - prev) / (arc[j] - prev || 1);
      const alongBend = along[j - 1] + (along[j] - along[j - 1]) * f;
      const perpBend = perp[j - 1] + (perp[j] - perp[j - 1]) * f;
      out.push(mix(bend!, curveAt(alongBend, perpBend)));
      injected = true;
    }
    // Octilinear point by monotonic arc-length; curve point by chord (along,perp).
    out.push(mix(octiAt(arc[j]), curveAt(along[j], perp[j])));
  }
  return out;
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

    const stationShapes = stations.map((s) => {
      const id = shapeIdFor.get(s.id)!;
      const pos = { x: s.cx - MARKER / 2, y: s.cy - MARKER / 2 };
      // Both layouts start at the geographic position, unrotated.
      geoPos.current.set(id, { ...pos, rotation: 0 });
      customPos.current.set(id, { ...pos, rotation: 0 });
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
      if (line.geoSegments.length) {
        lineSegGeo.current.set(
          lineId,
          line.geoSegments.map((seg) =>
            seg ? seg.map(([x, y]) => ({ x, y })) : null,
          ),
        );
      }
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

    // Reactive lines: when a station is dragged, redraw the lines through it.
    // Skipped while animating — the tween redraws lines itself.
    editor.sideEffects.registerAfterChangeHandler("shape", (prev, next) => {
      if (animating.current) return;
      if (next.type !== "station") return;
      if (prev.x === next.x && prev.y === next.y) return;
      editor.run(
        () => {
          for (const shape of editor.getCurrentPageShapes()) {
            if (shape.type !== "tube-line") continue;
            const ids = shape.props.stationIds as TLShapeId[];
            // Dragging only happens in editable mode → octilinear connectors.
            if (ids.includes(next.id)) recomputeLine(editor, shape, null, true);
          }
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
        return [id, { x: s?.x ?? 0, y: s?.y ?? 0, rotation: s?.rotation ?? 0 }];
      }),
    );
    // Leaving editable mode: remember the user's custom layout first.
    if (geo) for (const [id, p] of starts) customPos.current.set(id, p);
    const targets = geo ? geoPos.current : customPos.current;

    // Precompute each line's per-pair OSM geometry so the tween can morph the
    // lines octilinear<->curve in lockstep with the station movement.
    // For each line, decompose each station-pair segment into (along, perp)
    // relative to its geo chord — so the tick can re-anchor it to the *current*
    // chord between its two live stations and keep stations on the line.
    const lineMorph = editor
      .getCurrentPageShapes()
      .filter((s): s is TubeLineShape => s.type === "tube-line")
      .map((s) => {
        const stationIds = s.props.stationIds as TLShapeId[];
        const segs = lineSegGeo.current.get(s.id);
        const segMorph: (SegProfile | null)[] = [];
        if (segs && segs.length === stationIds.length - 1) {
          for (const seg of segs) {
            if (!seg || seg.length < 2) {
              segMorph.push(null);
              continue;
            }
            // Segment endpoints are snapped to the geo station centres, so
            // they already run stationIds[i] -> stationIds[i+1] (no flip).
            // Decompose the segment's *full* point set (not a resample): at
            // morphFrac=1 the reconstruction then reproduces geoPath exactly, so
            // the hand-off to the static geo curve on settle is seamless — no
            // snap between the smooth geo line and the tween.
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
              if (k > 0) {
                cum += Math.hypot(p.x - seg[k - 1].x, p.y - seg[k - 1].y);
              }
              arc.push(cum);
            }
            const totalArc = cum || 1;
            for (let k = 0; k < arc.length; k++) arc[k] /= totalArc;
            segMorph.push({ along, perp, arc });
          }
        }
        return { id: s.id, stationIds, segMorph };
      });

    // Only animate stations that actually move (none, in the common no-edit
    // case) — keeps the whole-network tween cheap.
    const movingIds = ids.filter((id) => {
      const s = starts.get(id)!;
      const g = targets.get(id)!;
      return (
        Math.abs(s.x - g.x) > 0.5 ||
        Math.abs(s.y - g.y) > 0.5 ||
        Math.abs(s.rotation - g.rotation) > 1e-4
      );
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
              // Geographic mode is canonical (rotation 0); editable restores the
              // captured rotation. Leftover rotation would offset a station's
              // centre off the fixed curve.
              rotation: s.rotation + (g.rotation - s.rotation) * e,
            });
          }
          // Draw each line by blending every station-pair segment between its
          // octilinear editable shape (morphFrac 0) and its OSM curve
          // (morphFrac 1), anchored to the two CURRENT station centres. Because
          // every segment's endpoints sit exactly on a station centre, the
          // stations never detach from the line during the tween.
          const morphFrac = geo ? e : 1 - e;
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
      if (t < 1) {
        animFrame.current = requestAnimationFrame(tick);
      } else {
        animFrame.current = null;
        animating.current = false;
        // Settle: geographic snaps lines onto the real OSM track curves;
        // editable settles onto octilinear connectors.
        recomputeAllLines(editor, geo ? lineGeo.current : null, !geo);
        editor.updateInstanceState({ isReadonly: geo });
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
