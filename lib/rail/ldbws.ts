import "server-only";
import { XMLParser } from "fast-xml-parser";

// Minimal client for National Rail's Darwin LDBWS ("OpenLDBWS") SOAP web
// service — the request/response face of Darwin, the rail industry's
// official prediction engine. One GetArrDepBoardWithDetails call returns a
// station's combined arrival/departure board where every service carries its
// FULL calling-point lists (previous + subsequent) with estimated times, so
// a single board sighting is enough to reconstruct a train's remaining
// journey ladder. Register for a token via the Rail Data Marketplace /
// National Rail developer portal (free); set RAIL_LDB_TOKEN.

const DEFAULT_URL =
  "https://lite.realtime.nationalrail.co.uk/OpenLDBWS/ldb11.asmx";
/** ldb namespace version — must match the endpoint's supported schema. */
const LDB_NS = "http://thalesgroup.com/RTTI/2017-10-01/ldb/";
const TOKEN_NS = "http://thalesgroup.com/RTTI/2013-11-28/Token/types";

/** One calling point on a service's route (times are "HH:mm" London-local). */
export interface LdbCallingPoint {
  locationName: string;
  crs: string;
  /** Scheduled time. */
  st?: string;
  /** Estimated time: "HH:mm" | "On time" | "Delayed" | "Cancelled" | "No report". */
  et?: string;
  /** Actual time (the train has called/passed): "HH:mm" | "On time". */
  at?: string;
}

/** One service row on a station board. */
export interface LdbService {
  serviceID: string;
  operatorCode: string;
  /** Scheduled/estimated arrival at the board station (absent for origins). */
  sta?: string;
  eta?: string;
  /** Scheduled/estimated departure from the board station (absent at destinations). */
  std?: string;
  etd?: string;
  destinationName: string;
  /** Calling points BEFORE the board station, oldest first (at = called). */
  previous: LdbCallingPoint[];
  /** Calling points AFTER the board station, soonest first. */
  subsequent: LdbCallingPoint[];
}

export interface LdbBoard {
  crs: string;
  generatedAt: string;
  services: LdbService[];
}

const parser = new XMLParser({
  ignoreAttributes: true,
  // Schema versions move the lt2/lt4/lt7 prefixes around — strip them all.
  removeNSPrefix: true,
  // Divided trains produce multiple callingPointLists; boards with one
  // service produce a bare object. Force the list shapes we iterate.
  isArray: (name) =>
    name === "service" ||
    name === "callingPointList" ||
    name === "callingPoint",
});

/** Coerce fast-xml-parser output (string | number | undefined) to a string. */
const str = (v: unknown): string =>
  v === undefined || v === null ? "" : String(v);

type RawCallingPoint = Record<string, unknown>;
type RawService = Record<string, unknown>;

function parseCallingPoints(node: unknown): LdbCallingPoint[] {
  if (!node || typeof node !== "object") return [];
  const lists =
    (node as { callingPointList?: unknown[] }).callingPointList ?? [];
  const out: LdbCallingPoint[] = [];
  for (const list of lists) {
    const pts =
      (list as { callingPoint?: RawCallingPoint[] }).callingPoint ?? [];
    for (const p of pts) {
      out.push({
        locationName: str(p.locationName),
        crs: str(p.crs),
        st: p.st === undefined ? undefined : str(p.st),
        et: p.et === undefined ? undefined : str(p.et),
        at: p.at === undefined ? undefined : str(p.at),
      });
    }
  }
  return out;
}

/**
 * Fetch a station's combined arrival/departure board with calling-point
 * details. Throws on transport or SOAP faults; the caller decides whether a
 * single failed board sinks the poll (it shouldn't).
 */
export async function fetchBoard(
  crs: string,
  opts?: { numRows?: number; timeWindow?: number; signal?: AbortSignal },
): Promise<LdbBoard> {
  const token = process.env.RAIL_LDB_TOKEN;
  if (!token) throw new Error("RAIL_LDB_TOKEN is not set");
  const url = process.env.RAIL_LDB_URL || DEFAULT_URL;
  const numRows = opts?.numRows ?? 20;
  const timeWindow = opts?.timeWindow ?? 120;

  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:typ="${TOKEN_NS}" xmlns:ldb="${LDB_NS}">
  <soap:Header><typ:AccessToken><typ:TokenValue>${token}</typ:TokenValue></typ:AccessToken></soap:Header>
  <soap:Body>
    <ldb:GetArrDepBoardWithDetailsRequest>
      <ldb:numRows>${numRows}</ldb:numRows>
      <ldb:crs>${crs}</ldb:crs>
      <ldb:timeWindow>${timeWindow}</ldb:timeWindow>
    </ldb:GetArrDepBoardWithDetailsRequest>
  </soap:Body>
</soap:Envelope>`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: "" },
    body: envelope,
    signal: opts?.signal,
    cache: "no-store",
  });
  const xml = await res.text();
  if (!res.ok) {
    throw new Error(`LDBWS ${crs} -> HTTP ${res.status}: ${xml.slice(0, 200)}`);
  }
  const doc = parser.parse(xml) as {
    Envelope?: {
      Body?: {
        Fault?: { faultstring?: unknown };
        GetArrDepBoardWithDetailsResponse?: {
          GetStationBoardResult?: Record<string, unknown>;
        };
      };
    };
  };
  const fault = doc?.Envelope?.Body?.Fault;
  if (fault) throw new Error(`LDBWS ${crs} fault: ${str(fault.faultstring)}`);
  const result =
    doc?.Envelope?.Body?.GetArrDepBoardWithDetailsResponse
      ?.GetStationBoardResult;
  if (!result) throw new Error(`LDBWS ${crs}: unrecognised response shape`);

  const rawServices =
    ((result.trainServices as { service?: RawService[] } | undefined)
      ?.service as RawService[] | undefined) ?? [];
  const services: LdbService[] = rawServices.map((s) => {
    const dest = (s.destination as { location?: unknown } | undefined)
      ?.location as
      { locationName?: unknown } | { locationName?: unknown }[] | undefined;
    const destName = Array.isArray(dest)
      ? str(dest[0]?.locationName)
      : str(dest?.locationName);
    return {
      serviceID: str(s.serviceID),
      operatorCode: str(s.operatorCode),
      sta: s.sta === undefined ? undefined : str(s.sta),
      eta: s.eta === undefined ? undefined : str(s.eta),
      std: s.std === undefined ? undefined : str(s.std),
      etd: s.etd === undefined ? undefined : str(s.etd),
      destinationName: destName,
      previous: parseCallingPoints(s.previousCallingPoints),
      subsequent: parseCallingPoints(s.subsequentCallingPoints),
    };
  });

  return { crs, generatedAt: str(result.generatedAt), services };
}
