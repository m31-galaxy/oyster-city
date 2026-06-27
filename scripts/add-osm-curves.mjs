// Augment lib/tube/network.generated.json with geographically-accurate line
// geometry ("geoPath": ordered [lon,lat]) from OpenStreetMap, via Oliver
// O'Brien's tfl_lines.json (OSM-derived, ODbL — attribute "© OpenStreetMap
// contributors"). Each source feature is a station-to-station LineString; we
// build each line-branch's curve by matching its consecutive station pairs to
// the nearest OSM segment (geometric, since station ids differ across
// sub-systems — e.g. Bakerloo DC vs Main — and per-branch records share a
// line name). Run after build-tube-data.mjs: `node scripts/add-osm-curves.mjs`.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC =
  "https://raw.githubusercontent.com/oobrien/vis/HEAD/tubecreature/data/tfl_lines.json";

const netPath = join(root, "lib/tube/network.generated.json");
const net = JSON.parse(readFileSync(netPath, "utf8"));
const geo = await (await fetch(SRC)).json();

const stationPos = new Map(net.stations.map((s) => [s.id, [s.lon, s.lat]]));
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const TOL = 0.004; // sum of the two endpoint gaps (each station ~<200m off)

/** OSM segment polylines for a line (each a [lon,lat][]). */
function segmentsFor(lineName) {
  const out = [];
  for (const f of geo.features) {
    if (!(f.properties.lines || []).some((l) => l.name === lineName)) continue;
    const g = f.geometry;
    out.push(g.type === "MultiLineString" ? g.coordinates.flat() : g.coordinates);
  }
  return out;
}

/** Build a branch's curve by matching each station pair to its OSM segment. */
function buildBranchCurve(stationIds, segs) {
  const curve = [];
  let matched = 0;
  let pairs = 0;
  const push = (c) => {
    const last = curve[curve.length - 1];
    if (!last || last[0] !== c[0] || last[1] !== c[1]) curve.push(c);
  };
  for (let i = 0; i < stationIds.length - 1; i++) {
    const A = stationPos.get(stationIds[i]);
    const B = stationPos.get(stationIds[i + 1]);
    if (!A || !B) continue;
    pairs++;
    let best = null;
    let bestScore = Infinity;
    let fwd = true;
    for (const seg of segs) {
      const s0 = seg[0];
      const s1 = seg[seg.length - 1];
      const f = dist(s0, A) + dist(s1, B);
      const r = dist(s0, B) + dist(s1, A);
      const score = Math.min(f, r);
      if (score < bestScore) {
        bestScore = score;
        best = seg;
        fwd = f <= r;
      }
    }
    if (best && bestScore < TOL) {
      (fwd ? best : [...best].reverse()).forEach(push);
      matched++;
    } else {
      // No matching track segment — fall back to the straight chord.
      push(A);
      push(B);
    }
  }
  return { curve, matched, pairs };
}

let added = 0;
const poor = [];
for (const line of net.lines) {
  if (line.stationIds.length < 2) continue;
  const segs = segmentsFor(line.name);
  if (!segs.length) continue;
  const { curve, matched, pairs } = buildBranchCurve(line.stationIds, segs);
  if (curve.length >= 2) {
    line.geoPath = curve;
    added++;
    if (pairs && matched / pairs < 0.8) poor.push(`${line.name}(${matched}/${pairs})`);
  }
}

writeFileSync(netPath, JSON.stringify(net));
console.log(`Added per-branch geoPath to ${added}/${net.lines.length} line records.`);
if (poor.length) console.log(`Low match rate (chord fallback) on: ${poor.join(", ")}`);
