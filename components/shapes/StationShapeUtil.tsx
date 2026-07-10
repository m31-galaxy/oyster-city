import { type CSSProperties } from "react";
import {
  HTMLContainer,
  Rectangle2d,
  ShapeUtil,
  T,
  useEditor,
  useValue,
  type TLBaseShape,
} from "tldraw";
import { hiddenLabels } from "@/lib/tube/labels";
import { closedStations, dimmedColour } from "@/lib/tube/status";
import { blueprintOn } from "@/lib/tube/blueprint";

export interface StationProps {
  w: number;
  h: number;
  name: string;
  stationId: string;
  interchange: boolean;
  labelPos: string;
  color: string;
}

// Register in tldraw's indexed-shapes registry (see TubeLineShapeUtil).
declare module "@tldraw/tlschema" {
  interface TLGlobalShapePropsMap {
    station: StationProps;
  }
}

/** A station marker + label. Interchanges render as a ringed circle. */
export type StationShape = TLBaseShape<"station", StationProps>;

const MARKER = 11; // interchange ring diameter (px)
const DOT = 7; // single-line tick diameter (px)
/** Below this zoom only interchanges are labelled; at/above it, every station. */
const LABEL_ZOOM = 0.7;
/** Ring/label ink; dims with the rest of the marker when the station closes. */
const INK = "#111111";
/** Label-ink dim mix: gentler than the geometry's default so 9px closed-
 * station names stay legible — #6C6C6C is ~4.8:1 against the canvas
 * background (WCAG AA for small text), where the lines' grey is ~2.6:1. */
const LABEL_DIM_MIX = 0.4;

export class StationShapeUtil extends ShapeUtil<StationShape> {
  static override type = "station" as const;
  static override props = {
    w: T.number,
    h: T.number,
    name: T.string,
    stationId: T.string,
    interchange: T.boolean,
    labelPos: T.string,
    color: T.string,
  };

  override getDefaultProps(): StationShape["props"] {
    return {
      w: MARKER,
      h: MARKER,
      name: "",
      stationId: "",
      interchange: false,
      labelPos: "E",
      color: "#666666",
    };
  }

  // Stations are fixed-size, orientation-free markers. Resize handles are
  // hidden for a single station, but canResize stays TRUE so that resizing a
  // multi-selection works: with no onResize defined, tldraw's resizeShape
  // repositions each shape at its scaled geometry-bounds centre (= the marker
  // centre) without changing its size — the selection spreads out / packs
  // together while every station keeps its shape.
  override canResize = () => true;
  override hideResizeHandles = () => true;
  override hideRotateHandle = () => true;
  override canEdit = () => false;
  override canBind = () => false;

  // Snapping: a station's ONLY snap point is its marker centre, so a dragged
  // station snaps exactly when it comes in line (horizontally/vertically)
  // with another station's centre — never to bounds corners or edges, and
  // the label stays invisible to snapping like it is to all other layout.
  override getBoundsSnapGeometry() {
    return { points: [{ x: MARKER / 2, y: MARKER / 2 }] };
  }

  // Stations have no orientation. When a (multi-)selection is rotated, tldraw
  // proposes a rotated shape; accept the movement but not the spin: place the
  // unrotated shape so its CENTRE sits where the proposed rotated centre is —
  // stations orbit the selection pivot while markers, labels, and selection
  // outlines stay axis-aligned. (A single station can't be rotated from the
  // UI — hideRotateHandle — and a programmatic rotate just orbits it about
  // its selection-bounds centre with rotation pinned to 0.)
  override onRotate = (_initial: StationShape, current: StationShape) => {
    const { w, h } = current.props;
    const cos = Math.cos(current.rotation);
    const sin = Math.sin(current.rotation);
    const cx = current.x + (w / 2) * cos - (h / 2) * sin;
    const cy = current.y + (w / 2) * sin + (h / 2) * cos;
    return {
      id: current.id,
      type: "station" as const,
      x: cx - w / 2,
      y: cy - h / 2,
      rotation: 0,
    };
  };

  // Geometry is the 11×11 marker rect ONLY: selection boxes, snapping, hit
  // targets, and every other layout concern see just the marker — the label
  // is invisible to all of them.
  override getGeometry(shape: StationShape) {
    return new Rectangle2d({
      width: shape.props.w,
      height: shape.props.h,
      isFilled: true,
    });
  }

  // Culling, however, must NOT hide a station whose overflowing HTML label is
  // still on screen (marker-bounds culling would pop edge labels). canCull is
  // only consulted for shapes whose bounds are already outside the viewport,
  // so here we veto the cull while the label's page rect (generously
  // estimated — overestimating only delays hiding) still intersects the
  // viewport. Labels hidden by decluttering don't veto. Assumes rotation 0,
  // which onRotate pins.
  override canCull = (shape: StationShape) => {
    const { name, interchange } = shape.props;
    if (!name) return true;
    const zoomed = this.editor.getZoomLevel() >= LABEL_ZOOM;
    if (!interchange && !zoomed) return true;
    const hidden = hiddenLabels.get();
    if ((zoomed ? hidden.all : hidden.interOnly).has(shape.id)) return true;
    const r = labelRect(shape.props);
    const vp = this.editor.getViewportPageBounds();
    return (
      shape.x + r.x > vp.maxX ||
      shape.x + r.x + r.w < vp.minX ||
      shape.y + r.y > vp.maxY ||
      shape.y + r.y + r.h < vp.minY
    );
  };

  override component(shape: StationShape) {
    const { name, interchange, labelPos, color, w, h } = shape.props;
    const editor = useEditor();
    // Interchanges are always labelled; other stations reveal as you zoom in;
    // decluttering hides the loser of any label-label overlap. The computed
    // value is a boolean, so a shape only re-renders when it flips — not on
    // every camera frame. The label element stays mounted and fades via CSS
    // (opacity + delayed visibility), so show/hide reads as a cross-fade
    // instead of a pop.
    const showLabel = useValue(
      "show-label",
      () => {
        if (!name) return false;
        const zoomed = editor.getZoomLevel() >= LABEL_ZOOM;
        if (!interchange && !zoomed) return false;
        const hidden = hiddenLabels.get();
        return !(zoomed ? hidden.all : hidden.interOnly).has(shape.id);
      },
      [editor, interchange, name, shape.id],
    );
    // A station dims only when EVERY line serving it is closed (the poll
    // publishes that set) — an interchange with one live line stays lit.
    // Boolean per shape, so it re-renders only when its own answer flips.
    const dimmed = useValue(
      "station-dimmed",
      () => closedStations.get().has(shape.props.stationId),
      [shape.props.stationId],
    );
    // The ring dims into the same family as the lines; the label dims LESS
    // (LABEL_DIM_MIX) so the name stays readable. On the blueprint backdrop
    // (edit mode) label ink flips to whitish-blue — drafting annotations —
    // since near-black ink sinks into the deep blue paper. The rings keep
    // their dark ink: white-filled circles read fine on blue.
    const blueprint = useValue(
      "station-blueprint",
      () => blueprintOn.get(),
      [],
    );
    const ringInk = dimmed ? dimmedColour(INK) : INK;
    const labelInk = blueprint
      ? dimmed
        ? "rgba(219, 234, 254, 0.55)"
        : "#eaf2ff"
      : dimmed
        ? dimmedColour(INK, LABEL_DIM_MIX)
        : INK;
    // Blueprint mode: white drafting ink around the marker — a crisp ring
    // plus a soft halo (box-shadow, no filters), faded in and out with the
    // mode so the flip stays smooth.
    const markerGlow: CSSProperties = {
      boxShadow: blueprint
        ? interchange
          ? "0 0 0 1.5px rgba(234, 242, 255, 0.65), 0 0 8px 2px rgba(219, 234, 254, 0.4)"
          : "0 0 0 1.5px rgba(234, 242, 255, 0.9), 0 0 7px 1px rgba(219, 234, 254, 0.45)"
        : "none",
      transition: "box-shadow 400ms ease",
    };
    const marker: CSSProperties = interchange
      ? {
          width: MARKER,
          height: MARKER,
          borderRadius: "50%",
          background: "#ffffff",
          border: `2.5px solid ${ringInk}`,
          boxSizing: "border-box",
          ...markerGlow,
        }
      : {
          width: DOT,
          height: DOT,
          margin: (MARKER - DOT) / 2,
          borderRadius: "50%",
          background: dimmed ? dimmedColour(color) : color,
          ...markerGlow,
        };

    return (
      // pointer-events: none — tldraw handles selection/drag via the shape's
      // geometry, so the marker is purely visual and never blocks a drag.
      <HTMLContainer style={{ pointerEvents: "none" }}>
        <div style={{ position: "relative", width: w, height: h }}>
          <div style={marker} />
          {/* Progressive labels: interchanges always, others on zoom-in. The
              selected station's name also shows in the sidebar. */}
          {name && (
            <div style={labelAnchorStyle()}>
              <span
                style={{
                  ...labelStyle(labelPos),
                  ...labelFade(showLabel),
                  color: labelInk,
                }}
              >
                {name}
              </span>
            </div>
          )}
        </div>
      </HTMLContainer>
    );
  }

  override getIndicatorPath(shape: StationShape) {
    const { w, h } = shape.props;
    const path = new Path2D();
    path.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    return path;
  }
}

/** Cross-fade for label show/hide. `visibility` flips after the fade ends so
 * a hidden label neither paints nor lingers as an invisible box. Ink-colour
 * changes (the blueprint flip, closed-line dimming) fade too. */
function labelFade(show: boolean): CSSProperties {
  return {
    opacity: show ? 1 : 0,
    visibility: show ? "visible" : "hidden",
    transition: "opacity 150ms ease, visibility 150ms, color 400ms ease",
  };
}

/**
 * Conservative shape-local rect over the rendered label's extent (9px/600
 * system-ui, single line), placed per the labelPos hint — mirrors labelStyle.
 * Used by canCull and the declutter pass; the label is deliberately NOT part
 * of the geometry.
 */
export function labelRect(props: StationProps): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const { w, h, name, labelPos } = props;
  const lw = name.length * 5.6 + 10; // ~5.2px/glyph + padding
  const lh = 14;
  const off = MARKER / 2 + 3; // matches labelStyle's offset from the centre
  const cx = w / 2;
  const cy = h / 2;
  const x = labelPos.includes("E")
    ? cx + off
    : labelPos.includes("W")
      ? cx - off - lw
      : cx - lw / 2;
  const y = labelPos.includes("N")
    ? cy - off - lh
    : labelPos.includes("S")
      ? cy + off
      : cy - lh / 2;
  return { x, y, w: lw, h: lh };
}

/** A zero-size anchor at the marker centre that the label offsets hang off. */
function labelAnchorStyle(): CSSProperties {
  return {
    position: "absolute",
    left: "50%",
    top: "50%",
    width: 0,
    height: 0,
  };
}

/** Place the label N/S/E/W of the marker centre per the labelPos hint.
 * Ink colour is supplied by the caller (it dims when the station closes). */
function labelStyle(pos: string): CSSProperties {
  const offset = MARKER / 2 + 3; // marker radius + gap, measured from the centre
  const style: CSSProperties = {
    position: "absolute",
    fontSize: 9,
    fontWeight: 600,
    lineHeight: 1.05,
    whiteSpace: "nowrap",
    pointerEvents: "none",
    fontFamily: "var(--font-tube), system-ui, -apple-system, sans-serif",
  };
  const transforms: string[] = [];

  if (pos.includes("N")) style.bottom = offset;
  else if (pos.includes("S")) style.top = offset;
  else {
    style.top = 0;
    transforms.push("translateY(-50%)");
  }

  if (pos.includes("E")) style.left = offset;
  else if (pos.includes("W")) {
    style.right = offset;
    style.textAlign = "right";
  } else {
    style.left = 0;
    transforms.push("translateX(-50%)");
    style.textAlign = "center";
  }

  if (transforms.length) style.transform = transforms.join(" ");
  return style;
}
