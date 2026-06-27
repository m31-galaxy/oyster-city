"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Tldraw,
  createShapeId,
  react,
  type Editor,
  type TLComponents,
} from "tldraw";
import "tldraw/tldraw.css";
import {
  StationShapeUtil,
  type StationShape,
} from "@/components/shapes/StationShapeUtil";
import { OctiLines } from "@/components/OctiLines";
import { getTubeNetwork } from "@/lib/tube/network";
import { selectStation } from "@/lib/tube/selection";

const shapeUtils = [StationShapeUtil];
const components: TLComponents = { OnTheCanvas: OctiLines };
const MARKER = 11;

/** Octilinear prototype scope: two simple, branch-free lines sharing Oxford Circus. */
const SCOPED = new Set(["bakerloo", "victoria"]);

/**
 * Octilinear-prototype canvas (the `'use client'` island).
 *
 * Shows only the Bakerloo + Victoria lines. Stations are DRAGGABLE tldraw
 * shapes; the connecting lines are drawn octilinearly (Beck-style) by
 * `OctiLines` (OnTheCanvas), which re-routes reactively as stations move.
 */
export default function TubeMap() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const handleMount = useCallback((editor: Editor) => {
    if (process.env.NODE_ENV !== "production") {
      (window as unknown as { editor?: Editor }).editor = editor;
    }

    // Clean slate (guards React double-invoke / stale state).
    const existing = [...editor.getCurrentPageShapeIds()];
    if (existing.length) {
      editor.run(() => editor.deleteShapes(existing), { ignoreShapeLock: true });
    }

    const net = getTubeNetwork();
    const ids = new Set<string>();
    for (const b of net.branches) {
      if (SCOPED.has(b.lineId)) for (const id of b.stationIds) ids.add(id);
    }

    const stationShapes = [...ids]
      .map((id) => net.stationsById.get(id))
      .filter((s): s is NonNullable<typeof s> => s != null)
      .map((s) => ({
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
    editor.createShapes<StationShape>(stationShapes);

    // Mirror the selected station into the sidebar readout (dragging still works).
    react("selected-station", () => {
      const sel = editor.getOnlySelectedShape();
      if (sel?.type === "station") {
        const st = sel as StationShape;
        selectStation({ id: st.props.stationId, name: st.props.name });
      }
    });

    // Fit once the viewport is measured. NOT readonly — stations stay draggable.
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
      <Tldraw
        shapeUtils={shapeUtils}
        components={components}
        hideUi
        onMount={handleMount}
      />
    </div>
  );
}
