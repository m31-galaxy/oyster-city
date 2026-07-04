import lineColours from "./line-colours.json";

// Official TfL line colours, keyed by Unified API line id (e.g. "victoria",
// "elizabeth", "lioness"). Shared with the schematic-map generator so the map
// and the sidebar status list stay in colour-sync. These functional colours
// are safe to use; the Tube-map artwork and roundel are separately protected.
export const LINE_COLOURS: Record<string, string> = lineColours;

export function lineColour(id: string): string {
  return LINE_COLOURS[id] ?? "#666666";
}

/** Lines drawn "hollow" on official TfL maps (National Rail-style casing):
 * two colour rails around a white core, cross-section 1/3-1/3-1/3. */
const HOLLOW_LINES = new Set([
  "dlr",
  "elizabeth",
  "liberty",
  "lioness",
  "mildmay",
  "suffragette",
  "thameslink",
  "tram",
  "weaver",
  "windrush",
]);

export function isHollowLine(id: string): boolean {
  return HOLLOW_LINES.has(id);
}

/** True National Rail services (not TfL): drawn hollow like the Overground
 * family but with a DASHED white core, as on official TfL maps. */
const NATIONAL_RAIL_LINES = new Set(["thameslink"]);

export function isNationalRailLine(id: string): boolean {
  return NATIONAL_RAIL_LINES.has(id);
}
