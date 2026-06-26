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
import { selectStation } from "@/lib/tube/selection";

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

  override canResize = () => false;
  override hideResizeHandles = () => true;
  override hideRotateHandle = () => true;
  override canEdit = () => false;
  override canBind = () => false;

  override getGeometry(shape: StationShape) {
    return new Rectangle2d({
      width: shape.props.w,
      height: shape.props.h,
      isFilled: true,
    });
  }

  override component(shape: StationShape) {
    const { name, stationId, interchange, labelPos, color, w, h } = shape.props;
    const editor = useEditor();
    // Interchanges are always labelled; other stations reveal as you zoom in.
    // The computed value is a boolean, so a shape only re-renders when it
    // crosses the threshold — not on every camera frame.
    const showLabel = useValue(
      "show-label",
      () => interchange || editor.getZoomLevel() >= LABEL_ZOOM,
      [editor, interchange],
    );
    const marker: CSSProperties = interchange
      ? {
          width: MARKER,
          height: MARKER,
          borderRadius: "50%",
          background: "#ffffff",
          border: "2.5px solid #111111",
          boxSizing: "border-box",
        }
      : {
          width: DOT,
          height: DOT,
          margin: (MARKER - DOT) / 2,
          borderRadius: "50%",
          background: color,
        };

    return (
      <HTMLContainer style={{ pointerEvents: "all", cursor: "pointer" }}>
        <div
          onPointerDown={(e) => {
            // Handle the tap ourselves; don't let tldraw start a pan/marquee.
            e.stopPropagation();
            selectStation({ id: stationId, name });
          }}
          style={{ position: "relative", width: w, height: h }}
        >
          <div style={marker} />
          {/* Progressive labels: interchanges always, others on zoom-in. Any
              station's name also shows in the sidebar on tap. */}
          {showLabel && <span style={labelStyle(labelPos)}>{name}</span>}
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

/** Place the label N/S/E/W of the marker per the dataset's labelPos hint. */
function labelStyle(pos: string): CSSProperties {
  const style: CSSProperties = {
    position: "absolute",
    fontSize: 9,
    fontWeight: 600,
    lineHeight: 1.05,
    color: "#111111",
    whiteSpace: "nowrap",
    pointerEvents: "none",
    fontFamily: "system-ui, -apple-system, sans-serif",
  };
  const transforms: string[] = [];

  if (pos.includes("N")) style.bottom = "calc(100% + 1px)";
  else if (pos.includes("S")) style.top = "calc(100% + 1px)";
  else {
    style.top = "50%";
    transforms.push("translateY(-50%)");
  }

  if (pos.includes("E")) style.left = "calc(100% + 3px)";
  else if (pos.includes("W")) {
    style.right = "calc(100% + 3px)";
    style.textAlign = "right";
  } else {
    style.left = "50%";
    transforms.push("translateX(-50%)");
    style.textAlign = "center";
  }

  if (transforms.length) style.transform = transforms.join(" ");
  return style;
}
