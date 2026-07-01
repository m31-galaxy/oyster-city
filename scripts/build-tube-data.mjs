// Build the complete tube network from the TfL Unified API and write it to
// lib/tube/network.generated.json. Run with `node scripts/build-tube-data.mjs`.
//
// For every line across tube/dlr/overground/elizabeth-line/tram we fetch the
// Route/Sequence (the ordered, geographically-located stop list) and assemble:
//   - lines:   one polyline per branch (in [lon, lat]) for drawing the line
//   - stations: deduped by hub, with interchange = served by >1 line
// The renderer (lib/tube/network.ts) projects [lon,lat] -> canvas coords.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "https://api.tfl.gov.uk";
const MODES = "tube,dlr,overground,elizabeth-line,tram";

const colours = JSON.parse(
  readFileSync(join(root, "lib/tfl/line-colours.json"), "utf8"),
);
const colourFor = (id) => colours[id] ?? "#666666";

function cleanName(name) {
  return name
    .replace(/\s+(Underground|DLR|Rail|Overground|Tram)\s+Station$/i, "")
    .replace(/\s+Station$/i, "")
    .replace(/\s*\((?:London|Berks|Bucks|Herts|Essex|Surrey|Kent)\)\s*$/i, "")
    .trim();
}

async function getJSON(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

const KX = Math.cos((51.5 * Math.PI) / 180); // London longitude compression
const SKIP_TOL_M = 600; // a bypassed station this close to the chord => express skip

/** Perpendicular distance (m) from station `p` to the chord a–b. */
function chordDist(p, a, b) {
  const ax = a.lon * KX, ay = a.lat, bx = b.lon * KX, by = b.lat;
  const px = p.lon * KX, py = p.lat;
  const vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy;
  let t = L2 ? ((px - ax) * vx + (py - ay) * vy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy)) * 111320;
}

/**
 * Drop redundant branch records per line. TfL returns a line as many overlapping
 * stop sequences, which double up as straight lines when drawn:
 *   - exact duplicates (same stop list), and
 *   - 2-stop express skips: a direct A→B that bypasses a served station C lying
 *     on the A–B chord, where the line also runs A→C and C→B (e.g. the Elizabeth
 *     line's Shenfield↔Liverpool St surface express drawn parallel to the
 *     via-Whitechapel tunnel — the triangle).
 * Genuine parallel branches survive (their bypassed station is far off the
 * chord) and so do bridges (no alternate A→C→B path exists).
 */
function pruneBranches(paths, stationMap) {
  const drop = new Set();
  const byLine = new Map();
  for (const p of paths) {
    if (!byLine.has(p.id)) byLine.set(p.id, []);
    byLine.get(p.id).push(p);
  }
  for (const group of byLine.values()) {
    const seen = new Set();
    for (const p of group) {
      const sig = p.stationIds.join(">");
      const rev = [...p.stationIds].reverse().join(">");
      if (seen.has(sig) || seen.has(rev)) drop.add(p);
      else seen.add(sig);
    }
    const live = group.filter((p) => !drop.has(p));
    const edges = new Set();
    for (const p of live)
      for (let i = 0; i < p.stationIds.length - 1; i++) {
        edges.add(p.stationIds[i] + "|" + p.stationIds[i + 1]);
        edges.add(p.stationIds[i + 1] + "|" + p.stationIds[i]);
      }
    const served = new Set(live.flatMap((p) => p.stationIds));
    for (const p of live) {
      if (p.stationIds.length !== 2) continue;
      const [A, B] = p.stationIds;
      const sa = stationMap.get(A);
      const sb = stationMap.get(B);
      if (!sa || !sb) continue;
      for (const C of served) {
        if (C === A || C === B) continue;
        if (!(edges.has(A + "|" + C) && edges.has(C + "|" + B))) continue;
        const sc = stationMap.get(C);
        if (sc && chordDist(sc, sa, sb) < SKIP_TOL_M) {
          drop.add(p);
          break;
        }
      }
    }
  }
  return paths.filter((p) => !drop.has(p));
}

const lines = await getJSON(`${BASE}/Line/Mode/${MODES}`);
console.log(`Fetched ${lines.length} lines`);

const stations = new Map(); // hubKey -> { id, name, lat, lon, lineSet, color }
const linePaths = []; // { id, name, color, points: [[lon,lat], ...] }
// Platform/stop NaPTAN id -> our station id (the hub key), for stops grouped
// under a hub. Live Arrivals give platform-level 940GZZLU* ids; our stationIds
// use HUB* ids for interchanges, so trains need this to resolve onto a line.
const naptanToHub = {};

for (const line of lines) {
  const colour = colourFor(line.id);
  let seq;
  try {
    seq = await getJSON(`${BASE}/Line/${line.id}/Route/Sequence/outbound`);
    if (!seq.stopPointSequences?.length) {
      seq = await getJSON(`${BASE}/Line/${line.id}/Route/Sequence/inbound`);
    }
  } catch (e) {
    console.warn(`  ! ${line.id}: ${e.message}`);
    continue;
  }

  const seqs = seq.stopPointSequences ?? [];
  let branches = 0;
  for (const sps of seqs) {
    const stops = (sps.stopPoint ?? []).filter(
      (sp) => typeof sp.lat === "number" && typeof sp.lon === "number",
    );
    if (stops.length < 2) continue;
    branches++;
    const hubKey = (sp) => sp.topMostParentId || sp.stationId || sp.id;
    linePaths.push({
      id: line.id,
      name: line.name,
      color: colour,
      points: stops.map((sp) => [sp.lon, sp.lat]),
      // Ordered station hub ids, aligned with `points` — lets the renderer
      // link line segments to station shapes for a reactive node-graph.
      stationIds: stops.map(hubKey),
    });
    for (const sp of stops) {
      // Group platforms/modes under the hub so multi-mode interchanges merge.
      const key = hubKey(sp);
      // Record the stop's raw NaPTAN ids so an Arrivals naptanId resolves to
      // our station id even when that id is a hub (HUB*).
      for (const raw of [sp.id, sp.stationId]) {
        if (raw && raw !== key) naptanToHub[raw] = key;
      }
      let st = stations.get(key);
      if (!st) {
        st = {
          id: key,
          name: cleanName(sp.name),
          lat: sp.lat,
          lon: sp.lon,
          lineSet: new Set(),
          color: colour,
        };
        stations.set(key, st);
      }
      st.lineSet.add(line.id);
    }
  }
  console.log(`  ${line.id.padEnd(16)} ${seqs.length} seq, ${branches} branch(es)`);
}

const prunedPaths = pruneBranches(linePaths, stations);
console.log(
  `Pruned ${linePaths.length - prunedPaths.length} redundant branch(es) ` +
    `(duplicates + express skips)`,
);

const stationList = [...stations.values()].map((s) => ({
  id: s.id,
  name: s.name,
  lat: s.lat,
  lon: s.lon,
  interchange: s.lineSet.size > 1,
  color: s.color,
}));

mkdirSync(join(root, "lib/tube"), { recursive: true });
const outPath = join(root, "lib/tube/network.generated.json");
writeFileSync(
  outPath,
  JSON.stringify({ lines: prunedPaths, stations: stationList, naptanToHub }),
);

console.log(`\nWrote ${outPath}`);
console.log(
  `  ${prunedPaths.length} line-paths, ${stationList.length} stations, ` +
    `${stationList.filter((s) => s.interchange).length} interchanges`,
);
