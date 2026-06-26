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

const lines = await getJSON(`${BASE}/Line/Mode/${MODES}`);
console.log(`Fetched ${lines.length} lines`);

const stations = new Map(); // hubKey -> { id, name, lat, lon, lineSet, color }
const linePaths = []; // { id, name, color, points: [[lon,lat], ...] }

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
    linePaths.push({
      id: line.id,
      name: line.name,
      color: colour,
      points: stops.map((sp) => [sp.lon, sp.lat]),
    });
    for (const sp of stops) {
      // Group platforms/modes under the hub so multi-mode interchanges merge.
      const key = sp.topMostParentId || sp.stationId || sp.id;
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
writeFileSync(outPath, JSON.stringify({ lines: linePaths, stations: stationList }));

console.log(`\nWrote ${outPath}`);
console.log(
  `  ${linePaths.length} line-paths, ${stationList.length} stations, ` +
    `${stationList.filter((s) => s.interchange).length} interchanges`,
);
