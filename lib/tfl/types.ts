// Minimal TfL Unified API response shapes used by Oyster City.
// Full schemas: https://api.tfl.gov.uk/swagger/ui/index.html

/** A single live arrival prediction (TfL `Prediction` entity, trimmed). */
export interface Prediction {
  id: string;
  lineId: string;
  lineName: string;
  stationName: string;
  platformName: string;
  destinationName: string;
  towards: string;
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
