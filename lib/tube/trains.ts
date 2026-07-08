import type { Prediction } from "@/lib/tfl/types";

// Derive live train trajectories from TfL Arrivals predictions. Pure +
// framework-free so it can be unit-checked against recorded arrivals. The
// renderer turns each trajectory into a page-space point via line geometry.
//
// Position model (validated against a recorded hour of live polls — see
// docs/train-position-accuracy.md):
//
//  - Everything is anchored to `expectedArrival` (absolute wall-clock), NEVER
//    to "timeToStation at fetch time". Arrivals responses are served through
//    three cache layers (TfL Varnish s-maxage=60, our proxy revalidate=30,
//    browser max-age=30) plus ~30-40s generation lag, so a payload is
//    typically 60-100s old on receipt and its age VARIES between polls.
//    Treating tts as fresh shifted every train's time base per poll — that was
//    the "all trains warp every few dozen seconds" bug. `expectedArrival` =
//    `timestamp + timeToStation` exactly (0 violations in 422k recorded
//    predictions), and TfL rarely revises it (median churn 0s), so absolute
//    time is stable no matter how stale the cache copy is.
//
//  - A record carries the vehicle's remaining prediction ladder resolved into
//    a piecewise trajectory (`steps`), not just the current segment. Between
//    polls the pose walks the steps, so a train that crosses a station keeps
//    moving onto the next segment instead of pinning at the platform and then
//    leaping a whole segment on the next poll (the dominant residual error
//    once absolute anchoring is in place).
//
// A line is drawn as several branch fragments (e.g. Northern has 9), so each
// step is resolved onto a specific BRANCH, and travel direction comes from the
// vehicle's own ladder order — never a global inbound/outbound rule, which
// only holds for unbranched lines.

/** A line branch's ordered station ids + a fast index lookup. */
export interface BranchInfo {
  /** The tube-line shape id — the branch key. */
  shapeId: string;
  /** Ordered network station ids for this branch. */
  stationIds: string[];
  indexOf: Map<string, number>;
}

/** One segment of a train's trajectory: a station pair + its time window. */
export interface TrainStep {
  branchShapeId: string;
  /** Forward pair index: the step runs on stationIds[segIndex]..[segIndex+1]. */
  segIndex: number;
  /** True when travelling from stationIds[segIndex+1] toward [segIndex]. */
  reversed: boolean;
  /** Epoch ms when the train starts this step (arrival at its start station). */
  startMs: number;
  /** Epoch ms when the train arrives at the step's end station. */
  endMs: number;
}

/** A live train's resolved trajectory over its upcoming stops. */
export interface TrainRecord {
  /** `${lineId}:${vehicleId}` — vehicleId alone is not unique across lines. */
  key: string;
  lineId: string;
  color: string;
  /** Epoch ms when the poll that built this record was received (blend trigger). */
  fetchMs: number;
  /** Piecewise trajectory, ordered by time, covering >= the poll horizon. */
  steps: TrainStep[];
}

/** The along-segment pose the renderer turns into a page-space point. */
export interface TrainPose {
  branchShapeId: string;
  segIndex: number;
  reversed: boolean;
  /** Progress 0..1 along the step in TRAVEL direction (not forward-pair). */
  f: number;
  /** False while holding at a station (dwell). */
  moving: boolean;
}

/** Fallback run time when a station position is missing. */
const FALLBACK_SEG_SECONDS = 120;
/** Assumed inter-station running speed (~36 km/h) — see tfl-api research. */
const SEG_SPEED_MPS = 10;
/** Clamp the distance-based estimate to plausible inter-station run times. */
const MIN_SEG_SECONDS = 25;
const MAX_SEG_SECONDS = 240;
/** Reject a ladder gap larger than one plausible segment when learning run times. */
const LADDER_MAX_SECONDS = 360;
/** Generous top speed for the ladder coherence check (m/s). Faster than any
 * real metro segment average, but slow enough that a SECOND physical train's
 * interleaved stops — typically kilometres away at a near-equal arrival time
 * — are unreachable and get dropped. */
const MAX_TRAVEL_MPS = 25;
/** Grace subtracted from the minimum travel time (dwell noise, short hops). */
const REACH_SLACK_S = 45;
/** Ignore previous-record matches further than this from a ladder stop's
 * arrival time when seeding the coherent chain. Loose enough for ea churn
 * plus a couple of missed polls (churn is p90 ~55s), tight enough not to
 * mistake a FOLLOWING train's arrival at the same station for ours. */
const SEED_MATCH_MAX_MS = 180_000;
/** Build steps until they cover this far past fetch (poll interval + staleness + slack). */
const STEP_HORIZON_MS = 180_000;
const MAX_STEPS = 10;
/** Station dwell: hold at the platform this long after arrival before
 * departing (observed "At platform" runs: median ~44s incl. terminus layovers
 * and 20s sampling inflation — 30s is the plausible non-terminus figure). */
const DWELL_MS = 30_000;
/** ...but never more than this share of the step window (short segments). */
const DWELL_MAX_FRAC = 0.25;
const KX = Math.cos((51.5 * Math.PI) / 180); // London longitude compression

/**
 * Estimate a segment's run time (s) from the geographic distance between its
 * two stations at an assumed running speed. Stable across polls; used only
 * when no live vehicle gives us TfL's own run time for the segment.
 */
function segRunTimeFor(
  aId: string,
  bId: string,
  pos: Map<string, [number, number]>,
): number {
  const a = pos.get(aId);
  const b = pos.get(bId);
  if (!a || !b) return FALLBACK_SEG_SECONDS;
  const metres = Math.hypot((a[0] - b[0]) * KX, a[1] - b[1]) * 111320;
  const secs = metres / SEG_SPEED_MPS;
  return secs < MIN_SEG_SECONDS
    ? MIN_SEG_SECONDS
    : secs > MAX_SEG_SECONDS
      ? MAX_SEG_SECONDS
      : secs;
}

/** Build a BranchInfo (with its index lookup) from an ordered station-id list. */
export function makeBranch(shapeId: string, stationIds: string[]): BranchInfo {
  const indexOf = new Map<string, number>();
  stationIds.forEach((id, i) => {
    // First occurrence wins (a branch shouldn't repeat a station anyway).
    if (!indexOf.has(id)) indexOf.set(id, i);
  });
  return { shapeId, stationIds, indexOf };
}

/** Parse a TfL ISO timestamp to epoch ms (second precision). */
const epoch = (iso: string): number => Date.parse(iso);

/**
 * Derive train trajectories for one line from its Arrivals predictions.
 * `branches` are that line's branch fragments; `naptanToHub` resolves an
 * arrival's platform NaPTAN to our station id. `fetchMs` is Date.now() at
 * receipt — used only as the blend trigger and the step-horizon origin, never
 * as a time base for positions. `prev` (last poll's records) provides
 * CONTINUITY: it seeds each vehicle's coherent ladder chain and breaks
 * branch-resolution ties, so a record keeps following the same physical
 * train down the same fragment instead of oscillating on data churn.
 */
export function deriveTrains(
  predictions: Prediction[],
  branches: BranchInfo[],
  naptanToHub: Record<string, string>,
  stationPos: Map<string, [number, number]>,
  lineId: string,
  color: string,
  fetchMs: number,
  prev?: ReadonlyMap<string, TrainRecord>,
): TrainRecord[] {
  const resolve = (naptan: string) => naptanToHub[naptan] ?? naptan;

  const byVehicle = new Map<string, Prediction[]>();
  for (const p of predictions) {
    if (!p.vehicleId) continue;
    const list = byVehicle.get(p.vehicleId);
    if (list) list.push(p);
    else byVehicle.set(p.vehicleId, [p]);
  }

  const branchById = new Map(branches.map((b) => [b.shapeId, b]));

  /** Minimum seconds to travel between two stations (straight line at a
   * generous top speed) — the physical-coherence yardstick. Zero when either
   * position is unknown, so unknown geometry never rejects a stop. */
  const straightSecs = (aId: string, bId: string): number => {
    const a = stationPos.get(aId);
    const b = stationPos.get(bId);
    if (!a || !b) return 0;
    const metres = Math.hypot((a[0] - b[0]) * KX, a[1] - b[1]) * 111320;
    return metres / MAX_TRAVEL_MPS;
  };

  /** Each travel-end station of the previous record's steps -> its predicted
   * arrival time, for matching fresh ladder stops to the train we were
   * already following. */
  const prevEnds = (rec: TrainRecord): Map<string, number> => {
    const ends = new Map<string, number>();
    for (const s of rec.steps) {
      const b = branchById.get(s.branchShapeId);
      if (!b) continue;
      const endId = b.stationIds[s.reversed ? s.segIndex : s.segIndex + 1];
      if (endId !== undefined && !ends.has(endId)) ends.set(endId, s.endMs);
    }
    return ends;
  };

  /** The previous record's branch at fetch time — the continuity tiebreak
   * for every ambiguous branch resolution below. */
  const prevBranchId = (rec: TrainRecord | undefined): string | null => {
    if (!rec) return null;
    for (const s of rec.steps) if (fetchMs < s.endMs) return s.branchShapeId;
    return rec.steps[rec.steps.length - 1]?.branchShapeId ?? null;
  };

  // First pass: each vehicle's ladder — its remaining stops in visit order,
  // each with its absolute predicted arrival time.
  type Stop = { stationId: string; eaMs: number };
  const ladders: { vehicleId: string; ladder: Stop[] }[] = [];
  for (const [vehicleId, preds] of byVehicle) {
    // Resolve to stations and dedup, keeping the earliest arrival
    // (kills the terminus Platform 1/2 double).
    const minEa = new Map<string, number>();
    for (const p of preds) {
      const ms = epoch(p.expectedArrival);
      if (!Number.isFinite(ms)) continue;
      const sid = resolve(p.naptanId);
      const cur = minEa.get(sid);
      if (cur === undefined || ms < cur) minEa.set(sid, ms);
    }
    const sorted = [...minEa.entries()]
      .map(([stationId, eaMs]) => ({ stationId, eaMs }))
      .sort((a, b) => a.eaMs - b.eaMs);
    if (!sorted.length) continue;

    // Coherence filter: TfL vehicleIds are NOT unique — two physical trains
    // regularly share one (small numeric ids recur per line), interleaving
    // both trains' stops into this ladder. Sorted by arrival time that reads
    // as a train teleporting kilometres in seconds: direction flips,
    // zero-width steps, cross-map warps. Keep only the chain of stops that
    // is physically reachable link by link; seed the chain from the stop
    // that best matches the PREVIOUS record's predicted arrivals, so across
    // polls the record keeps following the same physical train (seeding by
    // earliest arrival alone flips trains whenever the other one's next
    // stop sorts first).
    let seedIdx = 0;
    const old = prev?.get(`${lineId}:${vehicleId}`);
    if (old && sorted.length > 1) {
      const ends = prevEnds(old);
      // The FIRST (earliest-arrival) stop consistent with the previous
      // trajectory. Not min-|delta|: the whole chain matches the previous
      // record, so a 1-second fluke at a LATER chain station would beat the
      // true head and discard still-valid stops (measured at Hatton Cross
      // vs Hounslow West — the marker moved 1.3km to the wrong approach).
      const i = sorted.findIndex((stop) => {
        const e = ends.get(stop.stationId);
        return e !== undefined && Math.abs(e - stop.eaMs) < SEED_MATCH_MAX_MS;
      });
      if (i >= 0) seedIdx = i;
    }
    const ladder: Stop[] = [sorted[seedIdx]];
    for (let i = seedIdx + 1; i < sorted.length; i++) {
      const last = ladder[ladder.length - 1];
      const stop = sorted[i];
      const dt = (stop.eaMs - last.eaMs) / 1000;
      if (dt >= straightSecs(last.stationId, stop.stationId) - REACH_SLACK_S) {
        ladder.push(stop);
      }
    }
    ladders.push({ vehicleId, ladder });
  }

  // Learn per-segment run times from TfL's own predictions: the gap between
  // two consecutive stops in a vehicle's ladder is TfL's predicted run time
  // (incl. dwell) for that directed segment. Aggregating across vehicles gives
  // a stable, real per-segment estimate — far better than a fixed speed.
  const segSamples = new Map<string, number[]>();
  for (const { ladder } of ladders) {
    for (let i = 0; i < ladder.length - 1; i++) {
      const d = (ladder[i + 1].eaMs - ladder[i].eaMs) / 1000;
      if (d <= 0 || d > LADDER_MAX_SECONDS) continue; // skip gaps / dwell noise
      const key = `${ladder[i].stationId}>${ladder[i + 1].stationId}`;
      const arr = segSamples.get(key);
      if (arr) arr.push(d);
      else segSamples.set(key, [d]);
    }
  }
  const observedRunTime = (a: string, b: string): number | null => {
    const arr = segSamples.get(`${a}>${b}`);
    if (!arr || !arr.length) return null;
    const s = [...arr].sort((x, y) => x - y);
    return s[s.length >> 1]; // median
  };
  /** Best run-time estimate (s) for the directed pair a->b. */
  const runTime = (a: string, b: string): number =>
    observedRunTime(a, b) ??
    observedRunTime(b, a) ?? // ~symmetric
    segRunTimeFor(a, b, stationPos);

  /**
   * Resolve a directed station pair onto a branch. Prefers a branch where the
   * two are adjacent; otherwise the first branch containing both (the step is
   * then subdivided across the intermediate stations).
   */
  const resolvePair = (
    aId: string,
    bId: string,
  ): { branch: BranchInfo; ia: number; ib: number } | null => {
    let best: { branch: BranchInfo; ia: number; ib: number } | null = null;
    for (const b of branches) {
      const ia = b.indexOf.get(aId);
      const ib = b.indexOf.get(bId);
      if (ia === undefined || ib === undefined || ia === ib) continue;
      if (Math.abs(ib - ia) === 1) return { branch: b, ia, ib };
      if (!best) best = { branch: b, ia, ib };
    }
    return best;
  };

  /**
   * Append the unit-segment steps for travelling branch index `ia` -> `ib`
   * over the window [startMs, endMs]. A multi-segment span (a ladder stop that
   * didn't resolve, so the pair isn't adjacent) is subdivided proportionally
   * to each intermediate segment's run-time estimate.
   */
  const pushSteps = (
    steps: TrainStep[],
    branch: BranchInfo,
    ia: number,
    ib: number,
    startMs: number,
    endMs: number,
  ) => {
    const dir = Math.sign(ib - ia);
    const hops: { from: number; to: number; w: number }[] = [];
    for (let k = ia; k !== ib; k += dir) {
      hops.push({
        from: k,
        to: k + dir,
        w: runTime(branch.stationIds[k], branch.stationIds[k + dir]),
      });
    }
    const totalW = hops.reduce((s, h) => s + h.w, 0) || 1;
    let t = startMs;
    for (const h of hops) {
      const tEnd = t + ((endMs - startMs) * h.w) / totalW;
      steps.push({
        branchShapeId: branch.shapeId,
        segIndex: Math.min(h.from, h.to),
        reversed: h.to < h.from,
        startMs: t,
        endMs: tEnd,
      });
      t = tEnd;
    }
  };

  // A station's distinct neighbours across every fragment of the line. A
  // TRUE line terminus has exactly one; a fragment endpoint at an interior
  // junction has more — treating those as termini placed single-stop trains
  // a full segment down the wrong fragment (the Wembley Park oscillation).
  const neighbours = new Map<string, Set<string>>();
  for (const b of branches) {
    for (let i = 0; i < b.stationIds.length - 1; i++) {
      const x = b.stationIds[i];
      const y = b.stationIds[i + 1];
      (neighbours.get(x) ?? neighbours.set(x, new Set()).get(x)!).add(y);
      (neighbours.get(y) ?? neighbours.set(y, new Set()).get(y)!).add(x);
    }
  }

  const out: TrainRecord[] = [];
  for (const { vehicleId, ladder } of ladders) {
    const next = ladder[0];
    const second = ladder[1];
    const oldRec = prev?.get(`${lineId}:${vehicleId}`);
    const prevBid = prevBranchId(oldRec);

    // Pick the branch + travel direction for the CURRENT segment from the
    // ladder's index order. The pair can sit on several fragments: prefer
    // one where it's ADJACENT (edge dedup means at most one such), then the
    // previous record's fragment (continuity), then scan order — "first
    // fragment containing both" alone flip-flopped on poll churn.
    let branch: BranchInfo | undefined;
    let j0 = -1;
    let step = 0;
    if (second) {
      let bestScore = Infinity;
      for (const b of branches) {
        const a = b.indexOf.get(next.stationId);
        const c = b.indexOf.get(second.stationId);
        if (a === undefined || c === undefined || a === c) continue;
        const score =
          (Math.abs(c - a) === 1 ? 0 : 2) + (b.shapeId === prevBid ? 0 : 1);
        if (score < bestScore) {
          bestScore = score;
          branch = b;
          j0 = a;
          step = Math.sign(c - a);
          if (score === 0) break;
        }
      }
    }
    if (!branch) {
      // Single prediction (or a ladder sharing no branch): placeable only
      // when unambiguous — at the line's TRUE terminus, or on the fragment
      // the previous record was already following (a seam is fine when it's
      // the same seam).
      const trueTerminus = (neighbours.get(next.stationId)?.size ?? 0) === 1;
      let fallback: { b: BranchInfo; a: number } | null = null;
      for (const b of branches) {
        const a = b.indexOf.get(next.stationId);
        if (a === undefined) continue;
        if (a !== 0 && a !== b.stationIds.length - 1) continue;
        if (b.shapeId === prevBid) {
          fallback = { b, a };
          break;
        }
        if (trueTerminus && !fallback) fallback = { b, a };
      }
      if (fallback) {
        branch = fallback.b;
        j0 = fallback.a;
        step = j0 === 0 ? -1 : 1;
      }
    }
    if (!branch || step === 0) continue;

    let prevIdx = j0 - step;
    if (prevIdx < 0 || prevIdx >= branch.stationIds.length) {
      // `next` is this fragment's endpoint, but it's an interior junction on an
      // adjacent fragment (lines are split into overlapping branch fragments).
      // Relocate the train onto the branch that holds its real predecessor —
      // the neighbour of `next` on the side away from `second` — instead of
      // dropping it (otherwise trains vanish approaching junctions). The
      // side is ambiguous (several fragments, two neighbours each): prefer
      // the candidate whose implied approach step EXISTS in the previous
      // trajectory (the train was already travelling it), then the previous
      // fragment, then scan order — a blind first-match guessed the wrong
      // approach to Hatton Cross and teleported the train across Heathrow.
      let bestReloc: {
        b: BranchInfo;
        a: number;
        p: number;
        score: number;
      } | null = null;
      for (const b of branches) {
        const a = b.indexOf.get(next.stationId);
        if (a === undefined) continue;
        for (const p of [a - 1, a + 1]) {
          if (p < 0 || p >= b.stationIds.length) continue;
          if (second && b.stationIds[p] === second.stationId) continue;
          const wasTravelling = oldRec?.steps.some(
            (os) =>
              os.branchShapeId === b.shapeId &&
              os.segIndex === Math.min(a, p) &&
              os.reversed === a < p,
          );
          const score = wasTravelling ? 0 : b.shapeId === prevBid ? 1 : 2;
          if (!bestReloc || score < bestReloc.score)
            bestReloc = { b, a, p, score };
          if (score === 0) break;
        }
        if (bestReloc?.score === 0) break;
      }
      if (!bestReloc) continue; // a true terminus — nothing precedes it
      branch = bestReloc.b;
      j0 = bestReloc.a;
      prevIdx = bestReloc.p;
    }

    // Step 0 — the segment the train is on now. Its start time is synthetic
    // (we only know the upcoming arrival), backed out via the run-time table.
    const prevId = branch.stationIds[prevIdx];
    const nextId = branch.stationIds[j0];
    const steps: TrainStep[] = [
      {
        branchShapeId: branch.shapeId,
        segIndex: Math.min(prevIdx, j0),
        reversed: j0 < prevIdx,
        startMs: next.eaMs - runTime(prevId, nextId) * 1000,
        endMs: next.eaMs,
      },
    ];

    // Subsequent steps straight from the ladder: each consecutive stop pair is
    // a directed segment with exact absolute times at both ends.
    for (let i = 0; i < ladder.length - 1; i++) {
      const last = steps[steps.length - 1];
      if (steps.length >= MAX_STEPS || last.endMs - fetchMs > STEP_HORIZON_MS)
        break;
      const a = ladder[i];
      const b = ladder[i + 1];
      if (b.eaMs <= a.eaMs) continue; // dedup artefact — no usable window
      const r = resolvePair(a.stationId, b.stationId);
      if (!r) break; // ladder leaves our network — stop extending
      pushSteps(steps, r.branch, r.ia, r.ib, a.eaMs, b.eaMs);
    }

    out.push({
      key: `${lineId}:${vehicleId}`,
      lineId,
      color,
      fetchMs,
      steps,
    });
  }
  return out;
}

/** Floor for a stitched step-0 window so it can't collapse to nothing. */
const MIN_STEP_WINDOW_MS = 15_000;

/**
 * Carry trajectory knowledge across polls: a fresh record only knows its
 * current segment's END time (`expectedArrival` of the next stop) — its start
 * is backed out via the run-time table, which shifts between polls as the
 * median moves and disagrees with reality when the train ran late or dwelled
 * long. The PREVIOUS record often knew the segment's true predicted start
 * (it was a ladder-exact step: the arrival time at that station). Adopting it
 * pins both ends of the active segment, removing the dominant residual warp
 * (measured: p90 same-segment warp ~308m -> ~ea-churn only).
 */
export function stitchTrains(
  prev: ReadonlyMap<string, TrainRecord>,
  next: TrainRecord[],
): TrainRecord[] {
  for (const rec of next) {
    const old = prev.get(rec.key);
    const s0 = rec.steps[0];
    if (!old || !s0) continue;
    const k = old.steps.findIndex(
      (os) =>
        os.branchShapeId === s0.branchShapeId &&
        os.segIndex === s0.segIndex &&
        os.reversed === s0.reversed,
    );
    if (k < 0) continue;
    s0.startMs = Math.min(old.steps[k].startMs, s0.endMs - MIN_STEP_WINDOW_MS);
    // The fresh ladder reaches back only to its NEXT stop: when the head
    // prediction just dropped (stop served, or churn), the new step-0's
    // backed-out start can still lie in the future, and the pose would pin
    // at that segment's start station — a forward TELEPORT past every
    // intermediate station, where the train then freezes until the clock
    // catches up (measured 5.5km on the Elizabeth line: Hayes & Harlington
    // dropped, marker pinned at Hanwell). The old trajectory knows the
    // missing stretch: prepend its steps from the one active at fetch up to
    // the matched segment, so the train keeps walking the geometry it was
    // on and reaches the new step-0 when it genuinely gets there.
    let j = old.steps.length - 1;
    for (let i = 0; i < old.steps.length; i++) {
      if (rec.fetchMs < old.steps[i].endMs) {
        j = i;
        break;
      }
    }
    if (j < k) rec.steps.unshift(...old.steps.slice(j, k));
  }
  return next;
}

/** Smoothstep — zero velocity at both ends, gentle cruise in the middle. */
const smoothstep = (t: number) => t * t * (3 - 2 * t);

/** A step's dwell (hold-at-platform) duration within its window. */
const dwellOf = (s: TrainStep): number =>
  Math.min(DWELL_MS, (s.endMs - s.startMs) * DWELL_MAX_FRAC);

/**
 * Where a train is at wall-clock `nowMs`: walks the trajectory to the active
 * step, holds at the platform for the dwell, then moves with a smoothstep
 * profile (eases out of and into stations) arriving exactly at `endMs`.
 * Times beyond the trajectory clamp to its ends.
 */
export function trainPose(rec: TrainRecord, nowMs: number): TrainPose | null {
  const steps = rec.steps;
  if (!steps.length) return null;
  let s = steps[steps.length - 1];
  for (const st of steps) {
    if (nowMs < st.endMs) {
      s = st;
      break;
    }
  }
  const dwell = dwellOf(s);
  const t = nowMs - s.startMs;
  const span = s.endMs - s.startMs - dwell || 1;
  const fRaw = (t - dwell) / span;
  const f = fRaw <= 0 ? 0 : fRaw >= 1 ? 1 : smoothstep(fRaw);
  return {
    branchShapeId: s.branchShapeId,
    segIndex: s.segIndex,
    reversed: s.reversed,
    f,
    moving: fRaw > 0 && fRaw < 1,
  };
}

/**
 * Inverse of {@link trainPose}: the wall-clock time at which the trajectory
 * passes the given pose, or null when the trajectory never visits it. Lets
 * the renderer convert a poll's position correction into a TIME offset that
 * decays to zero — the train briefly runs slow (or pauses) instead of visibly
 * sliding backward along the track.
 */
export function trainTimeAt(rec: TrainRecord, pose: TrainPose): number | null {
  for (const s of rec.steps) {
    if (
      s.branchShapeId !== pose.branchShapeId ||
      s.segIndex !== pose.segIndex ||
      s.reversed !== pose.reversed
    ) {
      continue;
    }
    const f = pose.f <= 0 ? 0 : pose.f >= 1 ? 1 : pose.f;
    // Invert the smoothstep by bisection (monotonic on [0,1]).
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (smoothstep(mid) < f) lo = mid;
      else hi = mid;
    }
    const dwell = dwellOf(s);
    return s.startMs + dwell + ((lo + hi) / 2) * (s.endMs - s.startMs - dwell);
  }
  return null;
}
