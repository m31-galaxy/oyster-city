import {
  HTMLContainer,
  Rectangle2d,
  ShapeUtil,
  T,
  useEditor,
  useValue,
  type TLBaseShape,
} from "tldraw";
import { closedLines, dimmedColour } from "@/lib/tube/status";

/** Below this zoom the 10-unit National Rail dash marks are ≤3.5 screen px —
 * unreadable fuzz that still costs per-pixel pattern rasterisation across
 * ~68 core paths on every zoom/pan repaint. The core renders solid white
 * instead; the flip only happens on threshold crossings. */
const DASH_LOD_ZOOM = 0.35;

export interface TubeLineProps {
  w: number;
  h: number;
  color: string;
  d: string;
  /** National Rail-style casing (Elizabeth line / Overground / DLR / trams):
   * two colour rails around a white core, cross-section 1/3 colour, 1/3
   * white, 1/3 colour — as on official TfL maps. A hollow line is TWO shapes:
   * the casing (solid 6px colour) and a `core` twin (2px white) z-ordered
   * above ALL of the line's casings, so at forks one fragment's colour can
   * never overpaint another fragment's white channel. */
  hollow: boolean;
  /** True for the white-core twin of a hollow fragment. */
  core: boolean;
  /** National Rail (non-TfL) hollow lines draw their white core DASHED, as
   * on official TfL maps — the mark that distinguishes e.g. Thameslink from
   * the solid-cored Elizabeth line / Overground family. */
  dashed: boolean;
  /** TfL line id (e.g. "northern") — keys the closed-line dimming. */
  lineId: string;
  /** tldraw shape ids of the stations this line connects, in order. */
  stationIds: string[];
}

// Register the custom shape in tldraw's type system (tldraw 5 indexed-shapes
// registry) so it satisfies the `TLShape` constraint on ShapeUtil/createShapes.
declare module "@tldraw/tlschema" {
  interface TLGlobalShapePropsMap {
    "tube-line": TubeLineProps;
  }
}

/** A single Tube line: a coloured polyline through its station + bend points. */
export type TubeLineShape = TLBaseShape<"tube-line", TubeLineProps>;

export class TubeLineShapeUtil extends ShapeUtil<TubeLineShape> {
  static override type = "tube-line" as const;
  static override props = {
    w: T.number,
    h: T.number,
    color: T.string,
    d: T.string,
    hollow: T.boolean,
    core: T.boolean,
    dashed: T.boolean,
    lineId: T.string,
    stationIds: T.arrayOf(T.string),
  };

  override getDefaultProps(): TubeLineShape["props"] {
    return {
      w: 1,
      h: 1,
      color: "#666666",
      d: "",
      hollow: false,
      core: false,
      dashed: false,
      lineId: "",
      stationIds: [],
    };
  }

  // Read-only decoration: never editable, resizable, or bindable — and
  // invisible to snapping (stations align only to other stations).
  override canResize = () => false;
  override hideResizeHandles = () => true;
  override hideRotateHandle = () => true;
  override canEdit = () => false;
  override canBind = () => false;
  override canSnap = () => false;

  override getGeometry(shape: TubeLineShape) {
    return new Rectangle2d({
      width: Math.max(1, shape.props.w),
      height: Math.max(1, shape.props.h),
      isFilled: false,
    });
  }

  override component(shape: TubeLineShape) {
    const { w, h, color: lineColor, d, core, dashed, lineId } = shape.props;
    // Reactive LOD boolean — re-renders only when the threshold is crossed
    // (the StationShapeUtil.showLabel pattern). Non-dashed shapes short-
    // circuit before reading the zoom, so they never even subscribe to it.
    const editor = useEditor();
    const showDashes = useValue(
      "dashes-visible",
      () => dashed && editor.getZoomLevel() >= DASH_LOD_ZOOM,
      [editor, dashed],
    );
    // Fully-closed lines dim to a background-mixed grey (the same status set
    // that gates their ghost trains). Boolean per shape — re-renders only
    // when this line's closure flips.
    const dimmed = useValue(
      "line-dimmed",
      () => lineId !== "" && closedLines.get().has(lineId),
      [lineId],
    );
    const color = dimmed ? dimmedColour(lineColor) : lineColor;
    // Blueprint mode (edit): white drafting ink around the line — ONE crisp
    // opaque outline stroke. Deliberately not a drop-shadow filter (filters
    // re-rasterize per repaint) and no translucent halo twin (a second
    // 14px blended stroke per casing measurably slowed zoom re-rasters —
    // tile flicker). The path stays mounted; visibility is the map root's
    // .bp-mode class (one style pass, zero re-renders) flipped instantly —
    // no transition, so the toggle costs exactly one repaint. Casings only
    // — a hollow line's core twin rides its casing.
    // A National Rail core is NOT stroked with a dashed white line: where two
    // fragments' cores overlap along a junction stem, independent dash phases
    // union additively and can fill each other's gaps into solid white.
    // Instead the core is solid white with the colour interruptions stamped
    // ON TOP (the inverse pattern), so the topmost core owns any shared
    // stretch outright and phase interference can't happen. White dashes and
    // colour gaps are equal-length: 10-long marks on a 20 period, offset so
    // the white leads. Butt caps keep the marks crisp (round caps would
    // bleed 1px into the white).
    return (
      // pointer-events off so the stations layered on top receive taps.
      <HTMLContainer style={{ pointerEvents: "none" }}>
        <svg
          width={Math.max(1, w)}
          height={Math.max(1, h)}
          style={{ overflow: "visible", display: "block" }}
        >
          {!core && (
            <path
              className="bp-outline"
              d={d}
              fill="none"
              stroke="#eaf2ff"
              strokeWidth={9}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          )}
          <path
            d={d}
            fill="none"
            stroke={core ? "#ffffff" : color}
            strokeWidth={core ? 2 : 6}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {core && showDashes && (
            <path
              d={d}
              fill="none"
              stroke={color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="butt"
              strokeDasharray="10 10"
              strokeDashoffset={10}
            />
          )}
        </svg>
      </HTMLContainer>
    );
  }

  override getIndicatorPath(shape: TubeLineShape) {
    const path = new Path2D();
    path.rect(0, 0, Math.max(1, shape.props.w), Math.max(1, shape.props.h));
    return path;
  }
}
