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
  /** Heading in radians — applied as a CSS rotation about the marker centre. */
  rot: number;
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
    rot: T.number,
  };

  override getDefaultProps(): TrainShape["props"] {
    return { w: TRAIN_W, h: TRAIN_H, color: "#111111", rot: 0 };
  }

  // Inert decoration: never resized, edited, bound, or selected by the user.
  override canResize = () => false;
  override hideResizeHandles = () => true;
  override hideRotateHandle = () => true;
  override canEdit = () => false;
  override canBind = () => false;

  // A train marker has tiny geometry bounds, so default culling would unmount it
  // (and it would pop out) the moment its centre crossed a screen edge — same
  // reasoning as StationShapeUtil.
  override canCull = () => false;

  override getGeometry(shape: TrainShape) {
    return new Rectangle2d({
      width: shape.props.w,
      height: shape.props.h,
      isFilled: true,
    });
  }

  override component(shape: TrainShape) {
    const { w, h, color, rot } = shape.props;
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
            // Rotate about the marker centre (default transform-origin) so the
            // shape's geometry centre stays exactly on the track point — tldraw's
            // own rotation would pivot about the top-left corner instead.
            transform: `rotate(${rot}rad)`,
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
