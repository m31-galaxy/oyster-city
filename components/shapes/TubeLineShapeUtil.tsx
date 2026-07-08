import {
  HTMLContainer,
  Rectangle2d,
  ShapeUtil,
  T,
  type TLBaseShape,
} from "tldraw";

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
    const { w, h, color, d, core, dashed } = shape.props;
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
          <path
            d={d}
            fill="none"
            stroke={core ? "#ffffff" : color}
            strokeWidth={core ? 2 : 6}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {core && dashed && (
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
