import "server-only";

// Client for National Rail's "Live Departure Board - Staff Version"
// (LDBSVWS) as productised on the Rail Data Marketplace: plain REST/JSON
// with an x-apikey consumer key. The staff version is strictly richer than
// the public boards: services carry a globally-unique Darwin `rid`, full
// ISO date-times with SECONDS precision, and `subsequentLocations` lists
// every remaining location INCLUDING passing points (isPass) — junction
// and passed-station anchors for free. The product routes the departures
// operations only (GetDepBoardWithDetails works; the arrivals and combined
// operations 500 with a routing fault), so coverage of a service's final
// stretch comes from record retention client-side, not arrivals boards.
// Docs: https://realtime.nationalrail.co.uk/LDBSVWS/docs/documentation.html

const DEFAULT_BASE =
  "https://api1.raildata.org.uk/1010-live-departure-board---staff-version1_0";

/** One location on a service's route. Times are "yyyy-MM-ddTHH:mm:ss"
 * Europe/London local with NO zone designator. Junctions have a tiploc but
 * no crs. s=scheduled, e=estimated, a=actual; ta/td=arrival/departure. */
export interface LdbsvLocation {
  locationName?: string;
  crs?: string | null;
  tiploc?: string;
  sta?: string | null;
  eta?: string | null;
  ata?: string | null;
  std?: string | null;
  etd?: string | null;
  atd?: string | null;
  isPass?: boolean;
  isCancelled?: boolean;
}

/** One service row on a departures board (times = the board station's). */
export interface LdbsvService {
  rid?: string;
  operatorCode?: string;
  isPassengerService?: boolean;
  isCancelled?: boolean;
  destination?: { locationName?: string }[];
  sta?: string | null;
  eta?: string | null;
  ata?: string | null;
  std?: string | null;
  etd?: string | null;
  atd?: string | null;
  subsequentLocations?: LdbsvLocation[] | null;
}

export interface LdbsvBoard {
  crs: string;
  generatedAt?: string;
  trainServices?: LdbsvService[] | null;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Europe/London wall-clock parts for an epoch, via Intl (server may be UTC). */
function londonParts(ms: number) {
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
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return {
    y: get("year"),
    mo: get("month"),
    d: get("day"),
    h: get("hour") % 24,
    mi: get("minute"),
    s: get("second"),
  };
}

/** The board request's time path segment: "yyyyMMddTHHmmss", London local. */
export function londonBoardTime(nowMs: number): string {
  const p = londonParts(nowMs);
  return `${p.y}${pad(p.mo)}${pad(p.d)}T${pad(p.h)}${pad(p.mi)}${pad(p.s)}`;
}

/**
 * Parse an LDBSV "yyyy-MM-ddTHH:mm:ss" (Europe/London local, no zone) to
 * epoch ms — Date.parse would read it in the SERVER's zone (UTC in
 * production, silently shifting every train by an hour in summer). Treat
 * the parts as UTC, then correct by London's offset at that instant;
 * iterated once more so DST boundaries converge.
 */
export function londonIsoToMs(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(iso);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  let guess = asUtc;
  for (let i = 0; i < 2; i++) {
    const p = londonParts(guess);
    const seen = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
    guess += asUtc - seen;
    if (asUtc === seen) break;
  }
  return guess;
}

/** Pause before the single retry of a spike-arrested (HTTP 429) request.
 * The RDM gateway smooths its per-second cap into ~10ms admission buckets,
 * so two boards fetched near-simultaneously can 429 while the actual rate
 * is far under the cap — a short wait lands the retry in a free bucket. */
const RETRY_429_MS = 400;

/** Fetch a station's departures board with full calling/passing details. */
export async function fetchDepBoard(
  crs: string,
  opts?: { numRows?: number; timeWindow?: number; signal?: AbortSignal },
): Promise<LdbsvBoard> {
  const key = process.env.RAIL_LDB_TOKEN;
  if (!key) throw new Error("RAIL_LDB_TOKEN is not set");
  const base = process.env.RAIL_LDB_URL || DEFAULT_BASE;
  const url =
    `${base}/LDBSVWS/api/20220120/GetDepBoardWithDetails/` +
    `${crs}/${londonBoardTime(Date.now())}` +
    `?numRows=${opts?.numRows ?? 20}&timeWindow=${opts?.timeWindow ?? 120}`;
  const get = () =>
    fetch(url, {
      headers: { "x-apikey": key, Accept: "application/json" },
      cache: "no-store",
      signal: opts?.signal,
    });
  let res = await get();
  if (res.status === 429) {
    await res.text().catch(() => {});
    await new Promise((r) => setTimeout(r, RETRY_429_MS));
    res = await get();
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `LDBSV ${crs} -> HTTP ${res.status}: ${body.slice(0, 160)}`,
    );
  }
  const body = (await res.json()) as Omit<LdbsvBoard, "crs">;
  return { crs, ...body };
}
