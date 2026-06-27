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

/** Interior turn angle at v (deg): 0 = straight, 180 = U-turn. */
function turnDeg(a, v, b) {
  const v1x = v[0] - a[0], v1y = v[1] - a[1];
  const v2x = b[0] - v[0], v2y = b[1] - v[1];
  const m1 = Math.hypot(v1x, v1y), m2 = Math.hypot(v2x, v2y);
  if (!m1 || !m2) return 0;
  const cos = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (m1 * m2)));
  return (Math.acos(cos) * 180) / Math.PI;
}

const lerp = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];

/**
 * Round only the sharp corners of a polyline (Chaikin-style cut at vertices
 * whose turn exceeds `maxTurn`). Smooths the chord-fallback lines (sharp
 * station corners) while leaving real OSM curves (gentle turns) ~untouched.
 */
function smoothSharpCorners(points, maxTurn = 18, iterations = 3) {
  let pts = points;
  for (let it = 0; it < iterations; it++) {
    const out = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const v = pts[i];
      if (turnDeg(pts[i - 1], v, pts[i + 1]) > maxTurn) {
        out.push(lerp(v, pts[i - 1], 0.25), lerp(v, pts[i + 1], 0.25));
      } else {
        out.push(v);
      }
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return pts;
}

// The 2015 source predates the Overground split — its segments are all tagged
// "London Overground"; the per-pair matcher picks each named line's track.
const OVERGROUND = new Set([
  "Liberty",
  "Lioness",
  "Mildmay",
  "Suffragette",
  "Weaver",
  "Windrush",
]);

/** OSM segment polylines for a line (each a [lon,lat][]). */
function segmentsFor(lineName) {
  const wanted = OVERGROUND.has(lineName) ? "London Overground" : lineName;
  const out = [];
  for (const f of geo.features) {
    if (!(f.properties.lines || []).some((l) => l.name === wanted)) continue;
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
    // Round the sharp station corners left by straight-chord fallbacks.
    line.geoPath = smoothSharpCorners(curve);
    added++;
    if (pairs && matched / pairs < 0.8) poor.push(`${line.name}(${matched}/${pairs})`);
  }
}

writeFileSync(netPath, JSON.stringify(net));
console.log(`Added per-branch geoPath to ${added}/${net.lines.length} line records.`);
if (poor.length) console.log(`Low match rate (chord fallback) on: ${poor.join(", ")}`);
