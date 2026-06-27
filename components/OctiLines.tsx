"use client";

import { useEditor, useValue } from "tldraw";
import { getTubeNetwork } from "@/lib/tube/network";
import type { StationShape } from "@/components/shapes/StationShapeUtil";
import {
  routeOctilinear,
  octiPathD,
  type OctiRouteInput,
} from "@/lib/tube/octilinear";

/** Lines currently in scope for the octilinear prototype. */
const SCOPED = new Set(["bakerloo", "victoria"]);

// Static topology (ordered station ids + colour per line) — computed once.
let memo: { routes: OctiRouteInput[]; w: number; h: number } | null = null;
function scoped() {
  if (!memo) {
    const net = getTubeNetwork();
    const routes = net.branches
      .filter((b) => SCOPED.has(b.lineId))
      .map((b) => ({ lineId: b.lineId, color: b.color, stationIds: b.stationIds }));
    memo = { routes, w: net.bounds.w, h: net.bounds.h };
  }
  return memo;
}

/**
 * Octilinear lines, drawn behind the stations (tldraw `OnTheCanvas`, page
 * space). Reactively reads live station positions, so the lines re-route as
 * stations are dragged — the routing itself is a pure function of positions
 * (see lib/tube/octilinear.ts).
 */
export function OctiLines() {
  const editor = useEditor();
  const { routes, w, h } = scoped();

  const paths = useValue(
    "octi-paths",
    () => {
      const positions = new Map<string, { x: number; y: number }>();
      for (const shape of editor.getCurrentPageShapes()) {
        if (shape.type !== "station") continue;
        const center = editor.getShapePageBounds(shape.id)?.center;
        const { stationId } = (shape as StationShape).props;
        if (center && stationId) {
          positions.set(stationId, { x: center.x, y: center.y });
        }
      }
      return routeOctilinear(positions, routes).map((r) => ({
        lineId: r.lineId,
        color: r.color,
        d: octiPathD(r.points, 16),
      }));
    },
    [editor, routes],
  );

  return (
    <svg
      width={w}
      height={h}
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        overflow: "visible",
        pointerEvents: "none",
      }}
    >
      {paths.map((p) => (
        <path
          key={p.lineId}
          d={p.d}
          fill="none"
          stroke={p.color}
          strokeWidth={8}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}
