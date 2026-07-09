import "server-only";
import type { Prediction } from "@/lib/tfl/types";
import { RAIL_LINES, type RailLineConfig } from "./lines";
import { fetchBoard, type LdbBoard, type LdbCallingPoint } from "./ldbws";
import { fixtureBoards } from "./fixture";

// Turn Darwin departure-board sightings into the SAME Prediction[] shape the
// TfL Arrivals endpoint yields, so lib/tube/trains.ts consumes National Rail
// lines with zero changes. Everything the train model needs survives the
// translation: a stable per-train identity (Darwin serviceID — unlike TfL
// vehicleIds these are genuinely unique), and a ladder of upcoming stops
// with ABSOLUTE expected times (LDBWS "HH:mm" London-local, resolved to the
// nearest occurrence — the same absolute-time anchoring that made tube
// positions cache-proof).

/** Only emit a train once it is inside the drawn network, or due at its
 * first drawn station this soon — otherwise a Bedford train 25 minutes out
 * would sit parked as a ghost at the map-edge station until it arrived. */
const ENTRY_GATE_MS = 10 * 60_000;
/** Drop pending anchors this far in the past (board staleness guard). */
const STALE_MS = 90_000;

/** Resolve an LDBWS "HH:mm" (Europe/London local) to epoch ms, choosing the
 * occurrence nearest to now — boards straddle midnight in both directions. */
export function londonTimeToMs(hhmm: string, nowMs: number): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const target = Number(m[1]) * 60 + Number(m[2]);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(nowMs));
  const get = (t: string) =>
    Number(parts.find((p) => p.type === t)?.value ?? 0);
  const nowMin = (get("hour") % 24) * 60 + get("minute");
  let delta = target - nowMin;
  if (delta > 720) delta -= 1440;
  if (delta < -720) delta += 1440;
  // Land on the exact minute: strip now's seconds before applying the delta.
  return nowMs - get("second") * 1000 - (nowMs % 1000) + delta * 60_000;
}

/** Effective time of a calling point: actual, else estimate, else schedule.
 * "On time" (and other non-times like "Delayed"/"No report") fall through to
 * the schedule; "Cancelled" yields null so the anchor is skipped. */
function pointTimeMs(
  p: LdbCallingPoint,
  nowMs: number,
): {
  ms: number | null;
  called: boolean;
} {
  const resolve = (v: string | undefined): number | null => {
    if (!v) return null;
    if (/cancelled/i.test(v)) return null;
    return londonTimeToMs(v, nowMs);
  };
  if (p.at !== undefined) {
    return { ms: resolve(p.at) ?? resolve(p.st), called: true };
  }
  if (p.et !== undefined && /cancelled/i.test(p.et)) {
    return { ms: null, called: false };
  }
  return { ms: resolve(p.et) ?? resolve(p.st), called: false };
}

interface Anchor {
  crs: string;
  ms: number;
  called: boolean;
}

interface ServiceState {
  serviceID: string;
  destinationName: string;
  /** Best-known anchor per CRS (earliest time wins across boards). */
  anchors: Map<string, Anchor>;
}

/** Fold one board's sighting of a service into its accumulated anchor set. */
function foldService(
  state: ServiceState,
  board: LdbBoard,
  svc: { sta?: string; eta?: string; std?: string; etd?: string },
  prev: LdbCallingPoint[],
  next: LdbCallingPoint[],
  nowMs: number,
) {
  const add = (crs: string, ms: number | null, called: boolean) => {
    if (ms === null) return;
    const cur = state.anchors.get(crs);
    // Called (actual) beats estimate; otherwise keep the earliest estimate —
    // boards revise upward as delays develop, and the freshest board wins on
    // the next poll anyway.
    if (
      !cur ||
      (called && !cur.called) ||
      (called === cur.called && ms < cur.ms)
    ) {
      state.anchors.set(crs, { crs, ms, called });
    }
  };
  for (const p of prev) {
    const { ms, called } = pointTimeMs(p, nowMs);
    add(p.crs, ms, called);
  }
  // The board station row itself: prefer the arrival time, fall back to the
  // departure (origins have no sta).
  const rowTime =
    (svc.eta && !/on time|delayed|cancelled|no report/i.test(svc.eta)
      ? londonTimeToMs(svc.eta, nowMs)
      : null) ??
    (svc.sta ? londonTimeToMs(svc.sta, nowMs) : null) ??
    (svc.etd && !/on time|delayed|cancelled|no report/i.test(svc.etd)
      ? londonTimeToMs(svc.etd, nowMs)
      : null) ??
    (svc.std ? londonTimeToMs(svc.std, nowMs) : null);
  add(board.crs, rowTime, false);
  for (const p of next) {
    const { ms, called } = pointTimeMs(p, nowMs);
    add(p.crs, ms, called);
  }
}

/** Assemble Prediction[] for one configured line from its polled boards. */
function predictionsForLine(
  line: RailLineConfig,
  boards: LdbBoard[],
  nowMs: number,
): Prediction[] {
  const services = new Map<string, ServiceState>();
  for (const board of boards) {
    for (const svc of board.services) {
      if (!line.operatorCodes.includes(svc.operatorCode)) continue;
      if (!svc.serviceID) continue;
      let state = services.get(svc.serviceID);
      if (!state) {
        state = {
          serviceID: svc.serviceID,
          destinationName: svc.destinationName,
          anchors: new Map(),
        };
        services.set(svc.serviceID, state);
      }
      foldService(state, board, svc, svc.previous, svc.subsequent, nowMs);
    }
  }

  const out: Prediction[] = [];
  for (const state of services.values()) {
    const inNet = [...state.anchors.values()].filter(
      (a) => line.crsToStation[a.crs] !== undefined,
    );
    const pending = inNet
      .filter((a) => !a.called && a.ms > nowMs - STALE_MS)
      .sort((a, b) => a.ms - b.ms);
    if (!pending.length) continue;
    // Entry gate: inside the network already (has called at a drawn
    // station), or first drawn stop is imminent.
    const inside = inNet.some((a) => a.called);
    if (!inside && pending[0].ms - nowMs > ENTRY_GATE_MS) continue;
    for (const a of pending) {
      const stationId = line.crsToStation[a.crs];
      out.push({
        id: `${state.serviceID}:${a.crs}`,
        lineId: line.lineId,
        lineName: line.lineName,
        vehicleId: state.serviceID,
        naptanId: stationId,
        stationName: a.crs,
        platformName: "",
        direction: "",
        destinationNaptanId: "",
        destinationName: state.destinationName,
        towards: state.destinationName,
        currentLocation: "",
        timeToStation: Math.round((a.ms - nowMs) / 1000),
        expectedArrival: new Date(a.ms).toISOString(),
        modeName: "national-rail",
      });
    }
  }
  return out;
}

/** Which upstream produced the rail predictions (surfaced for debugging). */
export type RailSource = "fixture" | "darwin" | "disabled";

/**
 * Live arrivals for every configured National Rail line, in TfL Prediction
 * shape. Sources, in order: RAIL_FIXTURE=1 (synthetic moving services, for
 * development without credentials), RAIL_LDB_TOKEN (Darwin LDBWS), else [].
 * Board failures degrade per-board — one down station doesn't sink the poll.
 */
export async function getRailArrivals(): Promise<{
  source: RailSource;
  predictions: Prediction[];
}> {
  const nowMs = Date.now();
  if (process.env.RAIL_FIXTURE === "1") {
    return {
      source: "fixture",
      predictions: RAIL_LINES.flatMap((line) =>
        predictionsForLine(line, fixtureBoards(line, nowMs), nowMs),
      ),
    };
  }
  if (!process.env.RAIL_LDB_TOKEN)
    return { source: "disabled", predictions: [] };

  const out: Prediction[] = [];
  for (const line of RAIL_LINES) {
    const settled: PromiseSettledResult<LdbBoard>[] = await Promise.allSettled(
      line.boardCrs.map((crs) => fetchBoard(crs)),
    );
    const boards: LdbBoard[] = [];
    for (const [i, r] of settled.entries()) {
      if (r.status === "fulfilled") boards.push(r.value);
      else
        console.warn(
          `rail: board ${line.boardCrs[i]} failed: ${String(r.reason).slice(0, 160)}`,
        );
    }
    out.push(...predictionsForLine(line, boards, nowMs));
  }
  return { source: "darwin", predictions: out };
}
