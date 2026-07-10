import { atom } from "tldraw";

/** Whether the scroll wheel zooms (true, the default) or pans. Written by
 * the debug panel's wheel toggle; TubeMap's handleMount reacts to it and
 * pushes the matching wheelBehavior into the editor's camera options. */
export const wheelZooms = atom("wheelZooms", true);
