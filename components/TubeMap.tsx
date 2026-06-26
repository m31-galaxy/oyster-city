"use client";

import { useCallback, useEffect, useState } from "react";
import { Tldraw, createShapeId, type Editor } from "tldraw";
import "tldraw/tldraw.css";
import { TubeLineShapeUtil, type TubeLineShape } from "@/components/shapes/TubeLineShapeUtil";
import { StationShapeUtil, type StationShape } from "@/components/shapes/StationShapeUtil";
import { getTubeNetwork } from "@/lib/tube/network";

const shapeUtils = [TubeLineShapeUtil, StationShapeUtil];
const MARKER = 11;

/**
 * Read-only schematic Tube-map canvas (the `'use client'` island).
 *
 * On mount it builds the whole network from `getTubeNetwork()` — one
 * `tube-line` shape per line (coloured polyline) layered behind one `station`
 * shape per stop (interactive) — fits it to the viewport, then locks the
 * editor so users can only pan/zoom/tap. Gated behind `mounted` so tldraw
 * never touches `window` during Next's server prerender.
 */
export default function TubeMap() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const handleMount = useCallback((editor: Editor) => {
    // Dev affordance: reach the editor from the console (e.g. window.editor).
    if (process.env.NODE_ENV !== "production") {
      (window as unknown as { editor?: Editor }).editor = editor;
    }

    // Clean slate (guards React double-invoke / any stale state).
    const existing = [...editor.getCurrentPageShapeIds()];
    if (existing.length) editor.deleteShapes(existing);

    const net = getTubeNetwork();

    const lineShapes = net.lines.map((line) => {
      const xs = line.points.map((p) => p[0]);
      const ys = line.points.map((p) => p[1]);
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      const d = line.points
        .map((p, i) => `${i === 0 ? "M" : "L"} ${p[0] - minX} ${p[1] - minY}`)
        .join(" ");
      return {
        id: createShapeId(),
        type: "tube-line" as const,
        x: minX,
        y: minY,
        props: {
          w: Math.max(...xs) - minX || 1,
          h: Math.max(...ys) - minY || 1,
          color: line.color,
          d,
        },
      };
    });

    const stationShapes = net.stations.map((s) => ({
      id: createShapeId(),
      type: "station" as const,
      x: s.cx - MARKER / 2,
      y: s.cy - MARKER / 2,
      props: {
        w: MARKER,
        h: MARKER,
        name: s.name,
        stationId: s.id,
        interchange: s.interchange,
        labelPos: s.labelPos,
        color: s.color,
      },
    }));

    editor.createShapes<TubeLineShape | StationShape>([
      ...lineShapes,
      ...stationShapes,
    ]);

    // Fit once the viewport is actually measured — at onMount it can still be
    // 0×0, which makes zoomToFit a silent no-op (camera stuck at the origin).
    // Then lock the canvas to pan/zoom/tap only.
    const fitAndLock = () => {
      const vp = editor.getViewportScreenBounds();
      if (!vp || vp.w < 1 || vp.h < 1) {
        requestAnimationFrame(fitAndLock);
        return;
      }
      editor.zoomToFit();
      editor.updateInstanceState({ isReadonly: true });
    };
    requestAnimationFrame(fitAndLock);
  }, []);

  if (!mounted) return null;

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <Tldraw shapeUtils={shapeUtils} hideUi onMount={handleMount} />
    </div>
  );
}
