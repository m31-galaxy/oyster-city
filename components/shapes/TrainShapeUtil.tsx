import {
  HTMLContainer,
  Rectangle2d,
  ShapeUtil,
  T,
  type TLBaseShape,
} from "tldraw";

export interface TrainProps {
  w: number;
  h: number;
  color: string;
}

// Register the custom shape in tldraw's type system (see TubeLineShapeUtil).
declare module "@tldraw/tlschema" {
  interface TLGlobalShapePropsMap {
    train: TrainProps;
  }
}

/** A live train: a small coloured rectangle gliding along a line. */
export type TrainShape = TLBaseShape<"train", TrainProps>;

const TRAIN_W = 10;
const TRAIN_H = 6;

export class TrainShapeUtil extends ShapeUtil<TrainShape> {
  static override type = "train" as const;
  static override props = {
    w: T.number,
    h: T.number,
    color: T.string,
  };

  override getDefaultProps(): TrainShape["props"] {
    return { w: TRAIN_W, h: TRAIN_H, color: "#111111" };
  }

  // Inert decoration: never resized, edited, bound, selected — or snapped to.
  override canResize = () => false;
  override hideResizeHandles = () => true;
  override hideRotateHandle = () => true;
  override canEdit = () => false;
  override canBind = () => false;
  override canSnap = () => false;

  // Default culling applies: heading lives in the shape's top-level rotation,
  // so the page bounds cover the rotated marker exactly (the white border is
  // inside w/h via border-box) — a train is hidden only when it is genuinely
  // off-viewport. With ~650 trains and ~95% of the map off-screen when zoomed
  // in, this keeps the compositing layer small while panning.

  override getGeometry(shape: TrainShape) {
    return new Rectangle2d({
      width: shape.props.w,
      height: shape.props.h,
      isFilled: true,
    });
  }

  // Heading lives in the shape's top-level `rotation` (tldraw applies it to
  // the container), NOT in props: moving/turning a train then never changes
  // props, so this memoized component renders exactly once per train — with
  // 600+ trains updating every frame during the mode-morph, per-frame React
  // re-renders were the morph's dominant cost. The renderer counter-offsets
  // x/y so the centre stays on the track (tldraw rotates about the top-left).
  override component(shape: TrainShape) {
    const { w, h, color } = shape.props;
    return (
      // pointer-events off so taps fall through to the stations/lines beneath.
      <HTMLContainer style={{ pointerEvents: "none" }}>
        <div
          style={{
            width: w,
            height: h,
            background: color,
            borderRadius: 2,
            border: "1px solid rgba(255,255,255,0.9)",
            boxSizing: "border-box",
          }}
        />
      </HTMLContainer>
    );
  }

  override getIndicatorPath(shape: TrainShape) {
    const { w, h } = shape.props;
    const path = new Path2D();
    path.rect(0, 0, w, h);
    return path;
  }
}
