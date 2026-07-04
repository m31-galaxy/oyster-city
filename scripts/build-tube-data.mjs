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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fetch JSON politely: anonymous TfL access sustains ~12 req/min, so space
 * requests out and back off on 429 instead of failing the build. */
async function getJSON(url) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (res.status === 429 && attempt < 5) {
      console.warn(`  … 429, backing off (${url})`);
      await sleep(15_000);
      continue;
    }
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    await sleep(3_000);
    return res.json();
  }
}

const KX = Math.cos((51.5 * Math.PI) / 180); // London longitude compression
const SKIP_TOL_M = 600; // a bypassed station this close to the chord => express skip
/** ...and no further off-axis than this fraction of the chord length: only a
 * C nearly ON the line of travel marks a true express skip. The Elizabeth
 * Shenfield express (the case this prune exists for) measures 0.08; the DLR
 * West India Quay delta's connectors measure 0.20–0.29 and are all REAL
 * track (including the 2009 WIQ bypass viaduct), so they must survive —
 * when in doubt, keep the connector: extra real edges only help train
 * resolution, while a wrong drop orphans stations. */
const SKIP_REL_TOL = 0.12;

/** Unclamped projection of station `p` onto the chord a–b: `t` (fraction
 * along the chord) and perpendicular distance + chord length in metres. */
function chordProject(p, a, b) {
  const ax = a.lon * KX, ay = a.lat, bx = b.lon * KX, by = b.lat;
  const px = p.lon * KX, py = p.lat;
  const vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy;
  const t = L2 ? ((px - ax) * vx + (py - ay) * vy) / L2 : 0;
  const perp = Math.hypot(px - (ax + t * vx), py - (ay + t * vy)) * 111320;
  return { t, perp, chordLen: Math.sqrt(L2) * 111320 };
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
    // Edge multiset over live fragments — decremented as skips are dropped so
    // a drop is only justified by edges that actually SURVIVE. Without this,
    // the three 2-stop sides of the DLR's West India Quay delta junction
    // mutually eliminated each other and orphaned Westferry entirely.
    const edgeCount = new Map();
    const ekey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
    const bump = (k, d) => edgeCount.set(k, (edgeCount.get(k) ?? 0) + d);
    for (const p of live)
      for (let i = 0; i < p.stationIds.length - 1; i++)
        bump(ekey(p.stationIds[i], p.stationIds[i + 1]), 1);
    const alive = (a, b) => (edgeCount.get(ekey(a, b)) ?? 0) > 0;
    const served = new Set(live.flatMap((p) => p.stationIds));
    // Longest chord first: the true express/bypass chords are the long ones,
    // and dropping them consumes the "alternate path" budget before shorter
    // genuine junction sides come up for consideration.
    const candidates = live
      .filter((p) => p.stationIds.length === 2)
      .map((p) => {
        const sa = stationMap.get(p.stationIds[0]);
        const sb = stationMap.get(p.stationIds[1]);
        return sa && sb ? { p, sa, sb } : null;
      })
      .filter(Boolean)
      .sort(
        (x, y) =>
          chordProject(x.sa, x.sa, x.sb).chordLen -
          chordProject(y.sa, y.sa, y.sb).chordLen,
      )
      .reverse();
    for (const { p, sa, sb } of candidates) {
      const [A, B] = p.stationIds;
      for (const C of served) {
        if (C === A || C === B) continue;
        if (!(alive(A, C) && alive(C, B))) continue;
        const sc = stationMap.get(C);
        if (!sc) continue;
        const { t, perp, chordLen } = chordProject(sc, sa, sb);
        // C must sit strictly BETWEEN A and B (unclamped projection) and
        // close to the chord both absolutely and relative to its length —
        // otherwise C is a junction neighbour, not a bypassed stop.
        if (
          t > 0.1 &&
          t < 0.9 &&
          perp < SKIP_TOL_M &&
          perp < SKIP_REL_TOL * chordLen
        ) {
          drop.add(p);
          bump(ekey(A, B), -1);
          break;
        }
      }
    }
  }
  return paths.filter((p) => !drop.has(p));
}

/**
 * One drawn connection per station pair: with both directions fetched, later
 * fragments (typically inbound) re-cover edges already drawn by earlier ones
 * wherever a sequence isn't an exact mirror (one-way loops, express stopping
 * patterns). A re-covered edge is NOT invisible — the octilinear connector is
 * direction-dependent (its 45° diagonal leaves from the first endpoint), so
 * an A→B and a B→A drawing of the same pair double up as a parallelogram.
 * Trim each fragment to its maximal runs of unseen undirected edges,
 * splitting where needed; loop-only stretches survive, mirrored arms go.
 */
function dedupEdges(paths) {
  const seenByLine = new Map();
  const out = [];
  for (const p of paths) {
    let seen = seenByLine.get(p.id);
    if (!seen) seenByLine.set(p.id, (seen = new Set()));
    const ids = p.stationIds;
    const emit = (s, e) => {
      if (e - s < 1) return;
      out.push({
        ...p,
        points: p.points.slice(s, e + 1),
        stationIds: ids.slice(s, e + 1),
      });
    };
    let runStart = 0;
    for (let i = 0; i < ids.length - 1; i++) {
      const key =
        ids[i] < ids[i + 1]
          ? `${ids[i]}|${ids[i + 1]}`
          : `${ids[i + 1]}|${ids[i]}`;
      if (seen.has(key)) {
        emit(runStart, i);
        runStart = i + 1;
      } else {
        seen.add(key);
      }
    }
    emit(runStart, ids.length - 1);
  }
  return out;
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
  // BOTH directions: for two-way lines the inbound sequences are mirrors and
  // pruneBranches drops them as reversed duplicates, but one-way loops serve
  // DIFFERENT stops per direction — the Croydon town loop's northern side
  // (Reeves Corner, Centrale, West Croydon, Wellesley Road) exists only in
  // the inbound data and vanished entirely when only outbound was fetched.
  const seqs = [];
  for (const dir of ["outbound", "inbound"]) {
    try {
      const seq = await getJSON(`${BASE}/Line/${line.id}/Route/Sequence/${dir}`);
      seqs.push(...(seq.stopPointSequences ?? []));
    } catch (e) {
      console.warn(`  ! ${line.id} ${dir}: ${e.message}`);
    }
  }
  if (!seqs.length) continue;
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

const prunedBranches = pruneBranches(linePaths, stations);
console.log(
  `Pruned ${linePaths.length - prunedBranches.length} redundant branch(es) ` +
    `(duplicates + express skips)`,
);
const prunedPaths = dedupEdges(prunedBranches);
console.log(
  `Edge dedup: ${prunedBranches.length} -> ${prunedPaths.length} fragments ` +
    `(every station pair drawn once)`,
);

// Sanity: every line's stations must form ONE connected component through its
// fragment edges — pruning/dedup must never orphan a station (as the mutual
// elimination of the West India Quay delta's connectors once did to Westferry).
{
  const byLine = new Map();
  for (const p of prunedPaths) {
    if (!byLine.has(p.id)) byLine.set(p.id, []);
    byLine.get(p.id).push(p);
  }
  for (const [id, group] of byLine) {
    const adj = new Map();
    for (const p of group)
      for (let i = 0; i < p.stationIds.length - 1; i++) {
        const [a, b] = [p.stationIds[i], p.stationIds[i + 1]];
        (adj.get(a) ?? adj.set(a, new Set()).get(a)).add(b);
        (adj.get(b) ?? adj.set(b, new Set()).get(b)).add(a);
      }
    const all = [...adj.keys()];
    if (!all.length) continue;
    const seen = new Set([all[0]]);
    const stack = [all[0]];
    while (stack.length) {
      for (const n of adj.get(stack.pop()) ?? []) {
        if (!seen.has(n)) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
    const stranded = all.filter((s) => !seen.has(s));
    if (stranded.length) {
      console.warn(
        `  !! ${id}: DISCONNECTED stations: ${stranded
          .map((s) => stations.get(s)?.name ?? s)
          .join(", ")}`,
      );
    }
  }
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
writeFileSync(
  outPath,
  JSON.stringify({ lines: prunedPaths, stations: stationList, naptanToHub }),
);

console.log(`\nWrote ${outPath}`);
console.log(
  `  ${prunedPaths.length} line-paths, ${stationList.length} stations, ` +
    `${stationList.filter((s) => s.interchange).length} interchanges`,
);
