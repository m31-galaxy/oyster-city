import "server-only";
import type { Prediction } from "@/lib/tfl/types";
import { RAIL_LINES, type RailLineConfig } from "./lines";
import {
  fetchDepBoard,
  londonIsoToMs,
  type LdbsvBoard,
  type LdbsvLocation,
} from "./ldbsv";
import { fixtureBoards } from "./fixture";

// Turn staff departure-board sightings into the SAME Prediction[] shape the
// TfL Arrivals endpoint yields, so lib/tube/trains.ts consumes National Rail
// lines with zero changes. The staff data is strictly better than TfL's:
// identity is Darwin's globally-unique `rid` (no vehicleId collisions by
// construction), times are absolute ISO with seconds precision, and
// `subsequentLocations` includes PASSED stations (isPass) — extra anchors
// that tighten interpolation between calling points.
//
// Departures-board semantics: a service appears on the boards of stations
// it has yet to DEPART, each sighting carrying its full remaining route.
// After it leaves our last polled board, no board shows it again — the
// client keeps its last record walking to the trajectory's end instead
// (see the NR retention in TubeMap's poll).

/** Only emit a train once it is due at its first drawn station this soon —
 * otherwise a Bedford train 25 minutes out would sit parked as a ghost at
 * the map-edge station until it arrived. Services with an actual time at a
 * drawn station (already inside) always pass. */
const ENTRY_GATE_MS = 10 * 60_000;
/** Drop pending anchors this far in the past (board staleness guard). */
const STALE_MS = 90_000;

interface Anchor {
  stationId: string;
  ms: number;
  called: boolean;
}

/** A location's anchor time: prefer the ARRIVAL (that's what Prediction's
 * expectedArrival means), fall back to the departure (origins, passes at
 * some junctions); actual beats estimate beats schedule. */
function locationTime(loc: LdbsvLocation): {
  ms: number | null;
  called: boolean;
} {
  const arr = loc.ata ?? loc.eta ?? loc.sta;
  const dep = loc.atd ?? loc.etd ?? loc.std;
  const iso = arr ?? dep;
  if (!iso) return { ms: null, called: false };
  return {
    ms: londonIsoToMs(iso),
    called: loc.ata != null || loc.atd != null,
  };
}

/** Assemble Prediction[] for one configured line from its polled boards. */
function predictionsForLine(
  line: RailLineConfig,
  boards: LdbsvBoard[],
  nowMs: number,
): Prediction[] {
  // rid -> best-known anchors per station (a service can appear on several
  // boards; actuals beat estimates, then earliest wins).
  const services = new Map<
    string,
    { destination: string; anchors: Map<string, Anchor> }
  >();
  for (const board of boards) {
    for (const svc of board.trainServices ?? []) {
      if (!svc.rid) continue;
      if (svc.operatorCode && !line.operatorCodes.includes(svc.operatorCode))
        continue;
      if (svc.isPassengerService === false || svc.isCancelled) continue;
      let state = services.get(svc.rid);
      if (!state) {
        state = {
          destination: svc.destination?.[0]?.locationName ?? "",
          anchors: new Map(),
        };
        services.set(svc.rid, state);
      }
      const add = (
        stationId: string,
        t: { ms: number | null; called: boolean },
      ) => {
        if (t.ms === null) return;
        const cur = state.anchors.get(stationId);
        if (
          !cur ||
          (t.called && !cur.called) ||
          (t.called === cur.called && t.ms < cur.ms)
        ) {
          state.anchors.set(stationId, {
            stationId,
            ms: t.ms,
            called: t.called,
          });
        }
      };
      // The board station row itself...
      const rowStation = line.crsToStation[board.crs];
      if (rowStation) add(rowStation, locationTime(svc));
      // ...and every remaining location we draw. Passing points at drawn
      // stations (isPass) count too — extra anchors, better interpolation.
      // Junctions have no crs and stay unmapped for now.
      for (const loc of svc.subsequentLocations ?? []) {
        if (loc.isCancelled) continue;
        const stationId = loc.crs ? line.crsToStation[loc.crs] : undefined;
        if (!stationId) continue;
        add(stationId, locationTime(loc));
      }
    }
  }

  const out: Prediction[] = [];
  for (const [rid, state] of services) {
    const pending = [...state.anchors.values()]
      .filter((a) => !a.called && a.ms > nowMs - STALE_MS)
      .sort((a, b) => a.ms - b.ms);
    if (!pending.length) continue;
    // Entry gate: inside the network already (an actual time at a drawn
    // station), or first drawn stop is imminent.
    const inside = [...state.anchors.values()].some((a) => a.called);
    if (!inside && pending[0].ms - nowMs > ENTRY_GATE_MS) continue;
    for (const a of pending) {
      out.push({
        id: `${rid}:${a.stationId}`,
        lineId: line.lineId,
        lineName: line.lineName,
        vehicleId: rid,
        naptanId: a.stationId,
        stationName: a.stationId,
        platformName: "",
        direction: "",
        destinationNaptanId: "",
        destinationName: state.destination,
        towards: state.destination,
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
 * development without credentials), RAIL_LDB_TOKEN (staff departure boards
 * via the Rail Data Marketplace), else disabled. Board failures degrade
 * per-board — one down station doesn't sink the poll.
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
    const settled: PromiseSettledResult<LdbsvBoard>[] =
      await Promise.allSettled(line.boardCrs.map((crs) => fetchDepBoard(crs)));
    const boards: LdbsvBoard[] = [];
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
