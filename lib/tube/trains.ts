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

/** Network-median inter-station run time, used when we can't estimate one. */
const FALLBACK_SEG_SECONDS = 120;
/** Reject ladder deltas beyond this — they span a gap, not one segment. */
const MAX_SEG_SECONDS = 600;

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

  const out: TrainRecord[] = [];
  for (const [vehicleId, preds] of byVehicle) {
    // Resolve to stations and dedup, keeping the smallest time-to-station
    // (kills the terminus Platform 1/2 double).
    const minTts = new Map<string, number>();
    for (const p of preds) {
      const sid = resolve(p.naptanId);
      const cur = minTts.get(sid);
      if (cur === undefined || p.timeToStation < cur) minTts.set(sid, p.timeToStation);
    }
    // Ladder = remaining stops in visit order.
    const ladder = [...minTts.entries()]
      .map(([stationId, tts]) => ({ stationId, tts }))
      .sort((a, b) => a.tts - b.tts);
    if (ladder.length === 0) continue;

    const next = ladder[0];
    const second = ladder[1];

    // Pick the branch + travel direction from the ladder's index order.
    let branch: BranchInfo | undefined;
    let j0 = -1;
    let step = 0;
    let adjacent = false;
    if (second) {
      for (const b of branches) {
        const a = b.indexOf.get(next.stationId);
        const c = b.indexOf.get(second.stationId);
        if (a === undefined || c === undefined || a === c) continue;
        branch = b;
        j0 = a;
        step = Math.sign(c - a);
        adjacent = Math.abs(c - a) === 1;
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
          adjacent = false; // the ladder delta no longer describes this segment
          relocated = true;
          break;
        }
        if (relocated) break;
      }
      if (!relocated) continue; // a true terminus — nothing precedes it
    }

    // Only trust a ladder delta as the run time when the two stops are adjacent.
    let segRunTime = FALLBACK_SEG_SECONDS;
    if (adjacent && second) {
      const delta = second.tts - next.tts;
      if (delta > 0 && delta < MAX_SEG_SECONDS) segRunTime = delta;
    }

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
