import { atom } from "tldraw";

/** Whether the blueprint edit-mode backdrop is up (octolinear + edit mode).
 * Written by TubeMap's applyEditMode; read by the Background component that
 * paints the blueprint and by StationShapeUtil, whose label ink flips to a
 * whitish-blue so station names stay legible on the deep blue paper. */
export const blueprintOn = atom("blueprintOn", false);
