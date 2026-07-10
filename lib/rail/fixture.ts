import "server-only";
import type { RailLineConfig } from "./lines";
import type { LdbsvBoard, LdbsvService } from "./ldbsv";

// Synthetic staff departure boards for development without Rail Data
// Marketplace credentials (RAIL_FIXTURE=1): plausible service patterns over
// the drawn Thameslink corridors, anchored to wall-clock time so the trains
// genuinely run. Emits the same LDBSV JSON shapes (rids, ISO London-local
// times, subsequentLocations) so the whole parse/derive pipeline is
// exercised — only the HTTP layer is faked.

/** [crs, runSecondsFromPreviousStop] — first entry's seconds are ignored. */
type Pattern = [string, number][];

const PATTERNS: Record<string, { headwaySec: number; stops: Pattern }[]> = {
  thameslink: [
    {
      headwaySec: 480,
      stops: [
        ["ELS", 0],
        ["MIL", 180],
        ["HEN", 180],
        ["BCZ", 120],
        ["CRI", 120],
        ["WHP", 180],
        ["KTN", 180],
        ["STP", 240],
        ["ZFD", 180],
        ["CTK", 120],
        ["BFR", 120],
        ["LBG", 240],
        ["NWD", 540],
        ["ECR", 180],
        ["SCY", 180],
        ["PUR", 180],
        ["CDS", 180],
      ],
    },
    {
      headwaySec: 480,
      stops: [
        ["CDS", 0],
        ["PUR", 180],
        ["SCY", 180],
        ["ECR", 180],
        ["NWD", 180],
        ["LBG", 540],
        ["BFR", 240],
        ["CTK", 120],
        ["ZFD", 120],
        ["STP", 180],
        ["KTN", 240],
        ["WHP", 180],
        ["CRI", 180],
        ["BCZ", 120],
        ["HEN", 120],
        ["MIL", 180],
        ["ELS", 180],
      ],
    },
    {
      headwaySec: 600,
      stops: [
        ["LBG", 0],
        ["DEP", 300],
        ["GNW", 180],
        ["MZH", 120],
        ["WCB", 120],
        ["CTN", 120],
        ["WWA", 180],
        ["PLU", 120],
        ["ABW", 180],
        ["SGR", 240],
        ["DFD", 240],
      ],
    },
    {
      headwaySec: 600,
      stops: [
        ["DFD", 0],
        ["SGR", 240],
        ["ABW", 240],
        ["PLU", 180],
        ["WWA", 120],
        ["CTN", 180],
        ["WCB", 120],
        ["MZH", 120],
        ["GNW", 120],
        ["DEP", 180],
        ["LBG", 300],
      ],
    },
    {
      headwaySec: 720,
      stops: [
        ["EPH", 0],
        ["LGJ", 180],
        ["HNH", 180],
        ["TUH", 120],
        ["STE", 180],
        ["MTC", 180],
        ["MIJ", 120],
        ["HCB", 120],
        ["CSH", 120],
        ["SUO", 180],
      ],
    },
    {
      headwaySec: 720,
      stops: [
        ["SUO", 0],
        ["WSU", 120],
        ["SUC", 120],
        ["SIH", 120],
        ["MDS", 120],
        ["SMO", 120],
        ["WBO", 120],
        ["WIM", 180],
        ["HYR", 180],
        ["TOO", 120],
        ["STE", 180],
        ["TUH", 120],
        ["HNH", 120],
        ["LGJ", 180],
        ["EPH", 180],
      ],
    },
    {
      headwaySec: 900,
      stops: [
        ["VIC", 0],
        ["DMK", 360],
        ["PMR", 180],
        ["NHD", 120],
        ["CFT", 180],
        ["CTF", 120],
        ["BGM", 120],
        ["BEC", 120],
        ["RVB", 120],
        ["SRT", 180],
        ["BMS", 120],
        ["SMY", 240],
        ["SAY", 240],
      ],
    },
    {
      headwaySec: 900,
      stops: [
        ["NBA", 0],
        ["OKL", 120],
        ["NSG", 180],
        ["FPK", 300],
        ["STP", 360],
        ["ZFD", 180],
        ["CTK", 120],
        ["BFR", 120],
        ["LBG", 240],
      ],
    },
  ],
};

/** Epoch -> "yyyy-MM-ddTHH:mm:ss" Europe/London (the LDBSV wire format). */
const londonIso = (ms: number): string => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${Number(get("hour")) % 24 < 10 ? "0" : ""}${Number(get("hour")) % 24}:${get("minute")}:${get("second")}`;
};

/** Synthetic boards: every live service on every pattern, one fake board. */
export function fixtureBoards(
  line: RailLineConfig,
  nowMs: number,
): LdbsvBoard[] {
  const patterns = PATTERNS[line.lineId] ?? [];
  const services: LdbsvService[] = [];
  for (const [pi, pattern] of patterns.entries()) {
    const journeySec = pattern.stops.reduce((s, [, r]) => s + r, 0);
    const cycle = pattern.headwaySec;
    // One service departs the pattern origin every `headwaySec`; keep every
    // service currently mid-journey (plus one about to depart).
    const live = Math.ceil(journeySec / cycle) + 1;
    for (let k = 0; k < live; k++) {
      // Deterministic per (pattern, slot): the departure time is quantised to
      // the headway grid, so successive polls see the SAME service rids with
      // consistent times — exactly like re-polling a real board.
      const departMs = (Math.floor(nowMs / 1000 / cycle) - k) * cycle * 1000;
      const rid = `fix${line.lineId}${pi}x${Math.floor(departMs / 1000)}`;
      const subsequent = [];
      let t = departMs;
      for (const [i, [crs, run]] of pattern.stops.entries()) {
        if (i > 0) t += run * 1000 + 30_000; // run + dwell
        // Departures boards only carry the remaining route — visited stops
        // drop off. (Fixture stops are 2–4min apart, so the entry gate's
        // "first stop imminent" arm always admits in-flight services.)
        if (t <= nowMs) continue;
        const iso = londonIso(t);
        subsequent.push({
          crs,
          tiploc: crs,
          sta: iso,
          eta: iso,
          isPass: false,
        });
      }
      if (!subsequent.length) continue; // journey complete
      services.push({
        rid,
        operatorCode: line.operatorCodes[0],
        isPassengerService: true,
        isCancelled: false,
        destination: [
          { locationName: pattern.stops[pattern.stops.length - 1][0] },
        ],
        subsequentLocations: subsequent,
      });
    }
  }
  // A single synthetic board carrying every service; its own CRS is
  // deliberately unmapped so only the locations contribute anchors.
  return [
    { crs: "FIX", generatedAt: londonIso(nowMs), trainServices: services },
  ];
}
