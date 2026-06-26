import lineColours from "./line-colours.json";

// Official TfL line colours, keyed by Unified API line id (e.g. "victoria",
// "elizabeth", "lioness"). Shared with the schematic-map generator so the map
// and the sidebar status list stay in colour-sync. These functional colours
// are safe to use; the Tube-map artwork and roundel are separately protected.
export const LINE_COLOURS: Record<string, string> = lineColours;

export function lineColour(id: string): string {
  return LINE_COLOURS[id] ?? "#666666";
}
