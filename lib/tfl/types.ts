// Minimal TfL Unified API response shapes used by Oyster City.
// Full schemas: https://api.tfl.gov.uk/swagger/ui/index.html

/** A single live arrival prediction (TfL `Prediction` entity, trimmed). */
export interface Prediction {
  id: string;
  lineId: string;
  lineName: string;
  /** Train set number — NOT unique across lines; key by (lineId, vehicleId). */
  vehicleId: string;
  /** Platform NaPTAN id of the stop this prediction is for (940GZZLU*). */
  naptanId: string;
  stationName: string;
  platformName: string;
  /** "inbound" | "outbound"; empty at the terminus stop. */
  direction: string;
  destinationNaptanId: string;
  destinationName: string;
  towards: string;
  /** Free-text, e.g. "Between X and Y" — unreliable; cosmetic only. */
  currentLocation: string;
  /** Seconds until the vehicle reaches this stop. */
  timeToStation: number;
  /** ISO 8601 timestamp. */
  expectedArrival: string;
  modeName: string;
}

/** Status for one line (TfL `Line` entity with embedded `lineStatuses`). */
export interface LineStatus {
  id: string;
  name: string;
  modeName: string;
  lineStatuses: {
    /** 0–20 severity scale; 10 = "Good Service". */
    statusSeverity: number;
    statusSeverityDescription: string;
    reason?: string;
  }[];
}

/** A stop/station (TfL `StopPoint` entity, trimmed). */
export interface StopPoint {
  /** NaPTAN/ATCO id, e.g. "940GZZLUVIC" for Victoria Underground. */
  id: string;
  commonName: string;
  lat: number;
  lon: number;
  modes: string[];
  lines: { id: string; name: string }[];
}
