// Augment lib/tube/network.generated.json with geographically-accurate line
// geometry ("geoPath": ordered [lon,lat]) from OpenStreetMap, via Oliver
// O'Brien's tfl_lines.json (OSM-derived, ODbL — attribute "© OpenStreetMap
// contributors"). Each source feature is a station-to-station LineString
// tagged with the line name + start/end station ids; we stitch a line's
// segments into one continuous polyline by endpoint connectivity.
//
// Run after build-tube-data.mjs: `node scripts/add-osm-curves.mjs`.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC =
  "https://raw.githubusercontent.com/oobrien/vis/HEAD/tubecreature/data/tfl_lines.json";

const netPath = join(root, "lib/tube/network.generated.json");
const net = JSON.parse(readFileSync(netPath, "utf8"));

const geo = await (await fetch(SRC)).json();

/**
 * Stitch a line's segments into one continuous [lon,lat] polyline by GEOMETRIC
 * endpoint proximity (station ids differ across sub-systems — e.g. Bakerloo's
 * DC vs Main sections — so id-matching breaks the chain; coordinates don't).
 * Greedily grows a path from both ends by the nearest unused segment endpoint.
 */
const TOL = 0.0015; // ~150m, bridges platform-level gaps, well under station spacing

function stitch(segments) {
  if (!segments.length) return [];
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const remaining = segments.map((s) => s.coords);
  let path = remaining.shift();

  let progress = true;
  while (remaining.length && progress) {
    progress = false;
    const head = path[0];
    const tail = path[path.length - 1];
    let best = -1,
      bestD = Infinity,
      attach = "";
    for (let i = 0; i < remaining.length; i++) {
      const seg = remaining[i];
      const a = seg[0];
      const b = seg[seg.length - 1];
      const cands = [
        [dist(tail, a), "tail"],
        [dist(tail, b), "tail-flip"],
        [dist(head, b), "head"],
        [dist(head, a), "head-flip"],
      ];
      for (const [d, where] of cands) {
        if (d < bestD) (bestD = d), (best = i), (attach = where);
      }
    }
    if (best < 0 || bestD > TOL) break;

    let seg = remaining.splice(best, 1)[0];
    if (attach.includes("flip")) seg = [...seg].reverse();
    path = attach.startsWith("tail")
      ? path.concat(seg.slice(1))
      : seg.slice(0, -1).concat(path);
    progress = true;
  }
  return path;
}

function segmentsFor(lineName) {
  const out = [];
  for (const f of geo.features) {
    const meta = (f.properties.lines || []).find((l) => l.name === lineName);
    if (!meta) continue;
    const g = f.geometry;
    const coords =
      g.type === "MultiLineString" ? g.coordinates.flat() : g.coordinates;
    out.push({ start: meta.start_sid, end: meta.end_sid, coords });
  }
  return out;
}

let added = 0;
for (const line of net.lines) {
  const segs = segmentsFor(line.name);
  if (!segs.length) continue;
  const path = stitch(segs);
  if (path.length >= 2) {
    line.geoPath = path;
    added++;
    console.log(
      `  ${line.name.padEnd(16)} ${segs.length} segments -> ${path.length} curve points`,
    );
  }
}

writeFileSync(netPath, JSON.stringify(net));
console.log(`\nAdded geoPath to ${added}/${net.lines.length} line records.`);
