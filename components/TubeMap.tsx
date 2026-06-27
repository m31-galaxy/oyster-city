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
/** Point count used while morphing a line between straight and curved. */
const MORPH_POINTS = 120;

// Line ids to show — null shows the whole network.
const SHOWN_LINES: string[] | null = null;

type Pt = { x: number; y: number };
type Pose = { x: number; y: number; rotation: number };

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

/** Resample a polyline to `n` points spaced evenly by arc length. */
function resample(points: Pt[], n: number): Pt[] {
  if (points.length <= 1) return points.slice();
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  }
  const total = cum[cum.length - 1];
  if (total === 0) return Array.from({ length: n }, () => ({ ...points[0] }));
  const out: Pt[] = [];
  let seg = 0;
  for (let i = 0; i < n; i++) {
    const target = (i / (n - 1)) * total;
    while (seg < points.length - 2 && cum[seg + 1] < target) seg++;
    const segLen = cum[seg + 1] - cum[seg] || 1;
    const f = (target - cum[seg]) / segLen;
    out.push({
      x: points[seg].x + (points[seg + 1].x - points[seg].x) * f,
      y: points[seg].y + (points[seg + 1].y - points[seg].y) * f,
    });
  }
  return out;
}

/**
 * Redraw one line. With `curve` (the projected OSM track), it follows the real
 * geography; otherwise it draws straight segments through its stations' current
 * centres (the editable layout).
 */
function recomputeLine(editor: Editor, line: TubeLineShape, curve: Pt[] | null) {
  const pts =
    curve && curve.length >= 2
      ? curve
      : (line.props.stationIds as TLShapeId[])
          .map((id) => stationCentre(editor, id))
          .filter((c): c is Pt => !!c);
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

/** Redraw every line. Pass `lineGeo` to draw OSM curves, or null for straight. */
function recomputeAllLines(
  editor: Editor,
  lineGeo: Map<TLShapeId, Pt[]> | null,
) {
  editor.run(
    () => {
      for (const shape of editor.getCurrentPageShapes()) {
        if (shape.type === "tube-line") {
          recomputeLine(editor, shape, lineGeo?.get(shape.id) ?? null);
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
      const path = pathFromPoints(centres);
      // Stash the projected OSM track curve for geographic mode.
      if (line.geoPoints.length >= 2) {
        lineGeo.current.set(
          lineId,
          line.geoPoints.map(([x, y]) => ({ x, y })),
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
            // Dragging only happens in editable mode → straight segments.
            if (ids.includes(next.id)) recomputeLine(editor, shape, null);
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

    // Precompute each line's resampled OSM curve so the tween can morph the
    // lines straight<->curve in lockstep with the station movement.
    const lineMorph = editor
      .getCurrentPageShapes()
      .filter((s): s is TubeLineShape => s.type === "tube-line")
      .map((s) => {
        const stationIds = s.props.stationIds as TLShapeId[];
        const curve = lineGeo.current.get(s.id);
        let curveN =
          curve && curve.length >= 2 ? resample(curve, MORPH_POINTS) : null;
        // Orient the curve to the station order so its endpoints line up with
        // the straight path's — otherwise the line flips end-to-end mid-morph
        // (the OSM stitch direction can be the reverse of the route order).
        if (curveN) {
          const a = geoPos.current.get(stationIds[0]);
          const b = geoPos.current.get(stationIds[stationIds.length - 1]);
          if (a && b) {
            const head = curveN[0];
            const dA = Math.hypot(head.x - a.x, head.y - a.y);
            const dB = Math.hypot(head.x - b.x, head.y - b.y);
            if (dB < dA) curveN = curveN.slice().reverse();
          }
        }
        return { id: s.id, stationIds, curveN };
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
          // Morph each line between straight (through the current station
          // centres) and its OSM curve. morphFrac: 0 = straight, 1 = curve.
          const morphFrac = geo ? e : 1 - e;
          for (const lm of lineMorph) {
            const centres = lm.stationIds
              .map((id) => stationCentre(editor, id))
              .filter((c): c is Pt => !!c);
            if (centres.length < 2) continue;
            let pts: Pt[];
            if (lm.curveN && morphFrac > 0) {
              const straightN = resample(centres, MORPH_POINTS);
              pts = straightN.map((sp, i) => {
                const c = lm.curveN![i];
                return {
                  x: sp.x + (c.x - sp.x) * morphFrac,
                  y: sp.y + (c.y - sp.y) * morphFrac,
                };
              });
            } else {
              pts = centres;
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
        // Settle: geographic mode snaps lines onto the real OSM track curves.
        recomputeAllLines(editor, geo ? lineGeo.current : null);
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
