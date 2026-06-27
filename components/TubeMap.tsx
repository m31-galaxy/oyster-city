"use client";

import { useCallback, useEffect, useState } from "react";
import { Tldraw, createShapeId, type Editor, type TLShapeId } from "tldraw";
import "tldraw/tldraw.css";
import { TubeLineShapeUtil, type TubeLineShape } from "@/components/shapes/TubeLineShapeUtil";
import { StationShapeUtil, type StationShape } from "@/components/shapes/StationShapeUtil";
import { getTubeNetwork } from "@/lib/tube/network";
import { selectStation } from "@/lib/tube/selection";

const shapeUtils = [TubeLineShapeUtil, StationShapeUtil];
const MARKER = 11;

// For now we focus on two simple, branch-free lines that share exactly one
// station (Oxford Circus) — a clean testbed for the draggable node-graph.
const SHOWN_LINES = ["bakerloo", "victoria"];

type Pt = { x: number; y: number };

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

/**
 * Editable schematic Tube-map canvas (the `'use client'` island).
 *
 * Stations are draggable shapes; lines are locked decoration that recompute
 * their path whenever a connected station moves (via a store side-effect).
 * Built once per editor and gated behind `mounted` so tldraw never touches
 * `window` during Next's server prerender.
 */
export default function TubeMap() {
  const [mounted, setMounted] = useState(false);
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
    const lines = net.lines.filter((l) => SHOWN_LINES.includes(l.id));

    // For each station, how many shown lines use it (>1 ⇒ interchange here) and
    // a representative colour, plus its centre point.
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

    // Stable tldraw shape id per station, so lines can reference stations.
    const shapeIdFor = new Map<string, TLShapeId>(
      stations.map((s) => [s.id, createShapeId()]),
    );

    const stationShapes = stations.map((s) => ({
      id: shapeIdFor.get(s.id)!,
      type: "station" as const,
      x: s.cx - MARKER / 2,
      y: s.cy - MARKER / 2,
      props: {
        w: MARKER,
        h: MARKER,
        name: s.name,
        stationId: s.id,
        interchange: (lineCount.get(s.id) ?? 0) > 1,
        labelPos: s.labelPos,
        color: colourFor.get(s.id) ?? s.color,
      },
    }));

    const lineShapes = lines.map((line) => {
      const ids = line.stationIds
        .map((sid) => shapeIdFor.get(sid))
        .filter((id): id is TLShapeId => !!id);
      const centres = line.stationIds
        .map((sid) => centreFor.get(sid))
        .filter((c): c is Pt => !!c);
      const path = pathFromPoints(centres);
      return {
        id: createShapeId(),
        type: "tube-line" as const,
        x: path.x,
        y: path.y,
        // Locked: lines are non-interactive decoration (getShapeAtPoint skips
        // locked shapes, so only stations hover/select/drag).
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

    // Lines first → rendered behind the stations.
    editor.createShapes<TubeLineShape | StationShape>([
      ...lineShapes,
      ...stationShapes,
    ]);

    // Reactive lines: when a station moves, redraw the lines through it.
    editor.sideEffects.registerAfterChangeHandler("shape", (prev, next) => {
      if (next.type !== "station") return;
      if (prev.x === next.x && prev.y === next.y) return;
      editor.run(
        () => {
          for (const shape of editor.getCurrentPageShapes()) {
            if (shape.type !== "tube-line") continue;
            const ids = shape.props.stationIds as TLShapeId[];
            if (!ids.includes(next.id)) continue;
            const centres = ids
              .map((id) => stationCentre(editor, id))
              .filter((c): c is Pt => !!c);
            if (centres.length < 2) continue;
            const path = pathFromPoints(centres);
            editor.updateShape<TubeLineShape>({
              id: shape.id,
              type: "tube-line",
              x: path.x,
              y: path.y,
              props: { w: path.w, h: path.h, d: path.d },
            });
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

    // Fit once the viewport is measured (it can be 0×0 at onMount).
    const fit = () => {
      const vp = editor.getViewportScreenBounds();
      if (!vp || vp.w < 1 || vp.h < 1) {
        requestAnimationFrame(fit);
        return;
      }
      editor.zoomToFit();
    };
    requestAnimationFrame(fit);
  }, []);

  if (!mounted) return null;

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <Tldraw shapeUtils={shapeUtils} hideUi onMount={handleMount} />
    </div>
  );
}
