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
  };

  override getDefaultProps(): TubeLineShape["props"] {
    return { w: 1, h: 1, color: "#666666", d: "" };
  }

  // Read-only decoration: never editable, resizable, or bindable.
  override canResize = () => false;
  override hideResizeHandles = () => true;
  override hideRotateHandle = () => true;
  override canEdit = () => false;
  override canBind = () => false;

  override getGeometry(shape: TubeLineShape) {
    return new Rectangle2d({
      width: Math.max(1, shape.props.w),
      height: Math.max(1, shape.props.h),
      isFilled: false,
    });
  }

  override component(shape: TubeLineShape) {
    const { w, h, color, d } = shape.props;
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
            stroke={color}
            strokeWidth={6}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
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
