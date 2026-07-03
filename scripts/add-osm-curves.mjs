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

// Metric helpers for track routing (longitude compressed by cos(lat)).
const KX = Math.cos((51.5 * Math.PI) / 180);
const metres = (a, b) => Math.hypot((a[0] - b[0]) * KX, a[1] - b[1]) * 111320;
const SNAP_TOL_M = 450; // max station-to-track gap to trust a routed segment
const MAX_DETOUR = 2.6; // reject routes far longer than the straight line
// (2.6 admits the legitimate Heathrow T4 loop, measured 2.34x straight)
const STITCH_TOL_M = 30; // join way endpoints across tiny junction gaps
// Soft avoidance: a leg between two adjacent stops shouldn't thread through a
// THIRD station of the same line. Track near other stations costs extra, so
// near-ties (the T4 loop's fold-back through Hatton Cross beat the proper
// western arm by ~2%) resolve away from foreign platforms — but a route that
// genuinely must pass close to another station still wins (penalty, not
// exclusion), and MAX_DETOUR judges the TRUE length, not the penalised one.
const AVOID_M = 250; // "near another station" radius (the T4 loop fold-back
// passes 164m from the Hatton Cross station point — tracks run beside
// stations, not through their centroids)
const AVOID_PENALTY = 3; // weight multiplier on penalised edges

/**
 * Build an undirected routing graph from a line's OSM ways: vertices quantised
 * to ~1m become shared nodes, consecutive way vertices become weighted edges.
 * Lets us recover a station-pair curve even when the source stores the section
 * as one long way through several stations (e.g. the Elizabeth line tunnels).
 *
 * The source's ways don't share exactly-coincident vertices where a branch
 * meets its trunk (measured gaps ~3m), leaving each line's graph in dozens of
 * disconnected islands — every "two termini off one second-last stop" pair
 * (Chesham/Amersham, Heathrow T4/T5, Bank/Tower Gateway) was unreachable. So
 * after building, stitch every way ENDPOINT to any node within STITCH_TOL_M.
 *
 * `lineStations` ([id, [lon,lat]] of every station on the line, across all
 * fragments) marks which nodes sit within AVOID_M of which stations, for the
 * soft-avoidance penalty in routeAlongTrack.
 */
function buildTrackGraph(segs, lineStations) {
  const coord = new Map();
  const adj = new Map();
  const node = (p) => {
    const k = `${p[0].toFixed(5)},${p[1].toFixed(5)}`;
    if (!coord.has(k)) {
      coord.set(k, p);
      adj.set(k, []);
    }
    return k;
  };
  const ends = new Set();
  for (const seg of segs) {
    for (let i = 0; i < seg.length - 1; i++) {
      const a = node(seg[i]);
      const b = node(seg[i + 1]);
      if (a === b) continue;
      const w = metres(seg[i], seg[i + 1]);
      adj.get(a).push([b, w]);
      adj.get(b).push([a, w]);
    }
    if (seg.length >= 2) {
      ends.add(node(seg[0]));
      ends.add(node(seg[seg.length - 1]));
    }
  }
  const nodes = [...coord.keys()];
  for (const e of ends) {
    const pe = coord.get(e);
    for (const n of nodes) {
      if (n === e) continue;
      const d = metres(pe, coord.get(n));
      if (d > 0 && d <= STITCH_TOL_M && !adj.get(e).some(([v]) => v === n)) {
        adj.get(e).push([n, d]);
        adj.get(n).push([e, d]);
      }
    }
  }
  // Which stations each node is close to (usually none or one).
  const nearStations = new Map();
  if (lineStations?.length) {
    for (const n of nodes) {
      const p = coord.get(n);
      let ids = null;
      for (const [id, sp] of lineStations) {
        if (metres(p, sp) <= AVOID_M) (ids ??= []).push(id);
      }
      if (ids) nearStations.set(n, ids);
    }
  }
  return nodes.length ? { coord, adj, nodes, nearStations } : null;
}

/**
 * Shortest path along the track between the nodes nearest A and B. Returns the
 * polyline (endpoints snapped exactly to A,B for station attachment), or null
 * if either station is too far from the track or the route is an implausible
 * detour (a wrong branch). Edges near OTHER stations of the line (any id not
 * in `pairIds`) are penalised, so the search prefers routes that don't thread
 * through a third station's platforms; the detour check uses the true length.
 */
function routeAlongTrack(graph, A, B, pairIds) {
  const { coord, adj, nodes, nearStations } = graph;
  const foreign = (n) => {
    const ids = nearStations.get(n);
    return !!ids && ids.some((id) => !pairIds.has(id));
  };
  const snap = (pt) => {
    let best = null;
    let bd = Infinity;
    for (const k of nodes) {
      const d = metres(coord.get(k), pt);
      if (d < bd) {
        bd = d;
        best = k;
      }
    }
    return [best, bd];
  };
  const [sa, da] = snap(A);
  const [sb, db] = snap(B);
  if (sa === sb || da > SNAP_TOL_M || db > SNAP_TOL_M) return null;
  const distTo = new Map(nodes.map((n) => [n, Infinity]));
  const prev = new Map();
  distTo.set(sa, 0);
  const pq = [[0, sa]];
  while (pq.length) {
    let mi = 0;
    for (let i = 1; i < pq.length; i++) if (pq[i][0] < pq[mi][0]) mi = i;
    const [d, u] = pq.splice(mi, 1)[0];
    if (u === sb) break;
    if (d > distTo.get(u)) continue;
    const uForeign = foreign(u);
    for (const [v, w] of adj.get(u)) {
      const nd = d + w * (uForeign || foreign(v) ? AVOID_PENALTY : 1);
      if (nd < distTo.get(v)) {
        distTo.set(v, nd);
        prev.set(v, u);
        pq.push([nd, v]);
      }
    }
  }
  if (distTo.get(sb) === Infinity) return null;
  const path = [];
  for (let u = sb; u; u = prev.get(u)) path.unshift(coord.get(u));
  let trueLen = 0;
  for (let i = 1; i < path.length; i++) trueLen += metres(path[i - 1], path[i]);
  if (trueLen > metres(A, B) * MAX_DETOUR) return null;
  path[0] = [A[0], A[1]];
  path[path.length - 1] = [B[0], B[1]];
  return path;
}

/**
 * Centripetal Catmull-Rom samples for the P1->P2 span (P0,P3 = neighbours).
 * Passes exactly through P1 and P2, so a fallback segment stays attached to its
 * stations while curving smoothly (no sharp corner, no overshoot).
 */
function catmullRom(P0, P1, P2, P3, samples) {
  const knot = (ti, Pi, Pj) =>
    ti + Math.max(1e-6, Math.sqrt(Math.hypot(Pj[0] - Pi[0], Pj[1] - Pi[1])));
  const t0 = 0;
  const t1 = knot(t0, P0, P1);
  const t2 = knot(t1, P1, P2);
  const t3 = knot(t2, P2, P3);
  const mix = (Pa, Pb, ta, tb, t) => {
    const w = (t - ta) / (tb - ta);
    return [Pa[0] + (Pb[0] - Pa[0]) * w, Pa[1] + (Pb[1] - Pa[1]) * w];
  };
  const out = [];
  for (let s = 0; s < samples; s++) {
    const t = t1 + ((t2 - t1) * s) / (samples - 1);
    const A1 = mix(P0, P1, t0, t1, t);
    const A2 = mix(P1, P2, t1, t2, t);
    const A3 = mix(P2, P3, t2, t3, t);
    const B1 = mix(A1, A2, t0, t2, t);
    const B2 = mix(A2, A3, t1, t3, t);
    out.push(mix(B1, B2, t1, t2, t));
  }
  return out;
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
  const wanted = OVERGROUND.has(lineName)
    ? "London Overground"
    : lineName === "Tram"
      ? "Tramlink" // the source predates the "Trams"/"Tram" branding
      : lineName;
  const out = [];
  for (const f of geo.features) {
    if (!(f.properties.lines || []).some((l) => l.name === wanted)) continue;
    const g = f.geometry;
    out.push(g.type === "MultiLineString" ? g.coordinates.flat() : g.coordinates);
  }
  return out;
}

/** Build a branch's curve by matching each station pair to its OSM segment. */
function buildBranchCurve(stationIds, segs, lineStations) {
  const curve = [];
  // geoSegments[i] is the curve connecting stationIds[i]..stationIds[i+1]
  // (or null if a station position is missing) — kept aligned with the pairs.
  const geoSegments = [];
  let matched = 0;
  let pairs = 0;
  let graph; // line track graph, built lazily on the first routing fallback
  const push = (c) => {
    const last = curve[curve.length - 1];
    if (!last || last[0] !== c[0] || last[1] !== c[1]) curve.push(c);
  };
  for (let i = 0; i < stationIds.length - 1; i++) {
    const A = stationPos.get(stationIds[i]);
    const B = stationPos.get(stationIds[i + 1]);
    if (!A || !B) {
      geoSegments.push(null);
      continue;
    }
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
    let segPts;
    if (best && bestScore < TOL) {
      segPts = (fwd ? best : [...best].reverse()).map((p) => [p[0], p[1]]);
      // Anchor the endpoints exactly to the station positions so adjacent
      // segments meet at the shared station centre (the morph relies on this).
      segPts[0] = [A[0], A[1]];
      segPts[segPts.length - 1] = [B[0], B[1]];
      matched++;
    } else {
      // No station-to-station segment lines up. Try routing along the line's
      // stitched OSM track graph — recovers the curve where the source stores a
      // whole section as one long way (e.g. the post-2022 Elizabeth tunnels).
      if (graph === undefined) graph = buildTrackGraph(segs, lineStations);
      const routed =
        graph &&
        routeAlongTrack(
          graph,
          A,
          B,
          new Set([stationIds[i], stationIds[i + 1]]),
        );
      if (routed) {
        segPts = routed;
        matched++;
      } else {
        // Still nothing — a smooth Catmull-Rom through the neighbouring stations
        // (passes through A,B), so the fallback stays attached to its stations
        // instead of cutting a sharp corner.
        const prev = stationPos.get(stationIds[i - 1]);
        const next = stationPos.get(stationIds[i + 2]);
        const P0 = prev || [2 * A[0] - B[0], 2 * A[1] - B[1]];
        const P3 = next || [2 * B[0] - A[0], 2 * B[1] - A[1]];
        segPts = catmullRom(P0, A, B, P3, 10);
        segPts[0] = [A[0], A[1]];
        segPts[segPts.length - 1] = [B[0], B[1]];
      }
    }
    geoSegments.push(segPts);
    segPts.forEach(push);
  }
  return { curve, geoSegments, matched, pairs };
}

let added = 0;
const poor = [];
for (const line of net.lines) {
  if (line.stationIds.length < 2) continue;
  const segs = segmentsFor(line.name);
  if (!segs.length) continue;
  // Every station of this line (across all its fragments), for the routing
  // penalty — "other station" must include e.g. Hatton Cross when routing the
  // T4 loop fragment, which doesn't itself contain Hatton Cross.
  const lineStationIds = new Set(
    net.lines.filter((x) => x.name === line.name).flatMap((x) => x.stationIds),
  );
  const lineStations = [...lineStationIds]
    .map((id) => [id, stationPos.get(id)])
    .filter(([, p]) => p);
  const { curve, geoSegments, matched, pairs } = buildBranchCurve(
    line.stationIds,
    segs,
    lineStations,
  );
  if (curve.length >= 2) {
    // geoPath (settle render) = the per-pair segments concatenated; they pass
    // through every station, so the settled lines stay attached (matches the
    // morph). Chord fallbacks are now smooth Catmull-Rom, so no corner-rounding.
    line.geoPath = curve;
    line.geoSegments = geoSegments;
    added++;
    if (pairs && matched / pairs < 0.8) poor.push(`${line.name}(${matched}/${pairs})`);
  }
}

writeFileSync(netPath, JSON.stringify(net));
console.log(`Added per-branch geoPath to ${added}/${net.lines.length} line records.`);
if (poor.length) console.log(`Low match rate (chord fallback) on: ${poor.join(", ")}`);
