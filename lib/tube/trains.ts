import type { Prediction } from "@/lib/tfl/types";

// Derive live train positions from TfL Arrivals predictions. Pure + framework-
// free so it can be unit-checked against recorded arrivals. The renderer turns
// each record into a page-space point via the line geometry.
//
// A line is drawn as several branch fragments (e.g. Northern has 9), so a train
// is resolved onto a specific BRANCH, and its travel direction comes from the
// vehicle's own prediction ladder — never a global inbound/outbound rule, which
// only holds for unbranched lines.

/** A line branch's ordered station ids + a fast index lookup. */
export interface BranchInfo {
  /** The tube-line shape id — the branch key. */
  shapeId: string;
  /** Ordered network station ids for this branch. */
  stationIds: string[];
  indexOf: Map<string, number>;
}

/** A live train resolved onto one branch segment, with the kinematics to animate it. */
export interface TrainRecord {
  /** `${lineId}:${vehicleId}` — vehicleId alone is not unique across lines. */
  key: string;
  lineId: string;
  branchShapeId: string;
  /** Forward pair index: segment `segIndex` joins stationIds[segIndex]..[+1]. */
  segIndex: number;
  /** True when the train travels from stationIds[segIndex+1] toward [segIndex]. */
  reversed: boolean;
  /** Seconds to the next stop at capture time. */
  ttsAtFetch: number;
  /** performance.now() timestamp at capture. */
  fetchTime: number;
  /** Estimated run time (s) of the current segment. */
  segRunTime: number;
  color: string;
}

/** Fallback run time when a station position is missing. */
const FALLBACK_SEG_SECONDS = 120;
/** Assumed inter-station running speed (~36 km/h) — see tfl-api research. */
const SEG_SPEED_MPS = 10;
/** Clamp the distance-based estimate to plausible inter-station run times. */
const MIN_SEG_SECONDS = 25;
const MAX_SEG_SECONDS = 240;
/** Reject a ladder gap larger than one segment when learning run times. */
const LADDER_MAX_SECONDS = 360;
const KX = Math.cos((51.5 * Math.PI) / 180); // London longitude compression

/**
 * Estimate a segment's run time (s) from the geographic distance between its two
 * stations at an assumed running speed. Unlike the arrivals ladder delta this is
 * per-segment and STABLE across polls, so the tts->position mapping doesn't shift
 * between refreshes (a major cause of trains jumping on each poll).
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

/**
 * Derive train records for one line from its Arrivals predictions.
 * `branches` are that line's branch fragments; `naptanToHub` resolves an
 * arrival's platform NaPTAN to our station id.
 */
export function deriveTrains(
  predictions: Prediction[],
  branches: BranchInfo[],
  naptanToHub: Record<string, string>,
  stationPos: Map<string, [number, number]>,
  lineId: string,
  color: string,
  fetchTime: number,
): TrainRecord[] {
  const resolve = (naptan: string) => naptanToHub[naptan] ?? naptan;

  const byVehicle = new Map<string, Prediction[]>();
  for (const p of predictions) {
    if (!p.vehicleId) continue;
    const list = byVehicle.get(p.vehicleId);
    if (list) list.push(p);
    else byVehicle.set(p.vehicleId, [p]);
  }

  // First pass: each vehicle's ladder — its remaining stops in visit order.
  type Stop = { stationId: string; tts: number };
  const ladders: { vehicleId: string; ladder: Stop[] }[] = [];
  for (const [vehicleId, preds] of byVehicle) {
    // Resolve to stations and dedup, keeping the smallest time-to-station
    // (kills the terminus Platform 1/2 double).
    const minTts = new Map<string, number>();
    for (const p of preds) {
      const sid = resolve(p.naptanId);
      const cur = minTts.get(sid);
      if (cur === undefined || p.timeToStation < cur) minTts.set(sid, p.timeToStation);
    }
    const ladder = [...minTts.entries()]
      .map(([stationId, tts]) => ({ stationId, tts }))
      .sort((a, b) => a.tts - b.tts);
    if (ladder.length) ladders.push({ vehicleId, ladder });
  }

  // Learn per-segment run times from TfL's own predictions: the gap between two
  // consecutive stops in a vehicle's ladder is TfL's predicted run time for that
  // directed segment. Aggregating across all vehicles gives a stable, real
  // per-segment estimate — far better than a fixed speed, which is alternately
  // over/under on adjacent segments and yanks trains back and forth each poll.
  const segSamples = new Map<string, number[]>();
  for (const { ladder } of ladders) {
    for (let i = 0; i < ladder.length - 1; i++) {
      const d = ladder[i + 1].tts - ladder[i].tts;
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

  const out: TrainRecord[] = [];
  for (const { vehicleId, ladder } of ladders) {
    const next = ladder[0];
    const second = ladder[1];

    // Pick the branch + travel direction from the ladder's index order.
    let branch: BranchInfo | undefined;
    let j0 = -1;
    let step = 0;
    if (second) {
      for (const b of branches) {
        const a = b.indexOf.get(next.stationId);
        const c = b.indexOf.get(second.stationId);
        if (a === undefined || c === undefined || a === c) continue;
        branch = b;
        j0 = a;
        step = Math.sign(c - a);
        break;
      }
    }
    if (!branch) {
      // Single prediction (or a ladder that shares no branch): only placeable
      // when the next stop is a branch terminus, where prev is unambiguous.
      for (const b of branches) {
        const a = b.indexOf.get(next.stationId);
        if (a === undefined) continue;
        if (a === 0) { branch = b; j0 = 0; step = -1; break; }
        if (a === b.stationIds.length - 1) {
          branch = b; j0 = a; step = 1; break;
        }
      }
    }
    if (!branch || step === 0) continue;

    let prevIdx = j0 - step;
    if (prevIdx < 0 || prevIdx >= branch.stationIds.length) {
      // `next` is this fragment's endpoint, but it's an interior junction on an
      // adjacent fragment (lines are split into overlapping branch fragments).
      // Relocate the train onto the branch that holds its real predecessor — the
      // neighbour of `next` on the side away from `second` — instead of dropping
      // it (otherwise trains vanish for a whole segment approaching junctions).
      let relocated = false;
      for (const b of branches) {
        const a = b.indexOf.get(next.stationId);
        if (a === undefined) continue;
        for (const p of [a - 1, a + 1]) {
          if (p < 0 || p >= b.stationIds.length) continue;
          if (second && b.stationIds[p] === second.stationId) continue;
          branch = b;
          j0 = a;
          prevIdx = p;
          relocated = true;
          break;
        }
        if (relocated) break;
      }
      if (!relocated) continue; // a true terminus — nothing precedes it
    }

    // Prefer the run time TfL's own predictions imply for this exact segment;
    // fall back to the geographic estimate when no vehicle is predicting it.
    const prevId = branch.stationIds[prevIdx];
    const nextId = branch.stationIds[j0];
    const segRunTime =
      observedRunTime(prevId, nextId) ??
      observedRunTime(nextId, prevId) ??
      segRunTimeFor(prevId, nextId, stationPos);

    out.push({
      key: `${lineId}:${vehicleId}`,
      lineId,
      branchShapeId: branch.shapeId,
      segIndex: Math.min(prevIdx, j0),
      reversed: j0 < prevIdx,
      ttsAtFetch: next.tts,
      fetchTime,
      segRunTime,
      color,
    });
  }
  return out;
}

/** Progress [0,1] from prev->next given a train record and the current time. */
export function trainProgress(rec: TrainRecord, now: number): number {
  const ttsRemaining = rec.ttsAtFetch - (now - rec.fetchTime) / 1000;
  const f = (rec.segRunTime - ttsRemaining) / rec.segRunTime;
  return f < 0 ? 0 : f > 1 ? 1 : f;
}
