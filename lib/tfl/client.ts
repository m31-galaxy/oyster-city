import "server-only";
import type { LineStatus, Prediction, StopPoint } from "./types";

const TFL_BASE = "https://api.tfl.gov.uk";

/**
 * Server-only TfL Unified API client.
 *
 * The `app_key` stays on the server and is never shipped to the browser
 * (`server-only` makes importing this from a client component a build error).
 * Client components should fetch the `/api/tfl/*` proxy route instead.
 */
async function tflFetch<T>(path: string, revalidate = 30): Promise<T> {
  const key = process.env.TFL_APP_KEY;
  const sep = path.includes("?") ? "&" : "?";
  const url = key
    ? `${TFL_BASE}${path}${sep}app_key=${key}`
    : `${TFL_BASE}${path}`;

  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    next: { revalidate },
  });
  if (!res.ok) {
    throw new Error(`TfL ${path} → ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

/** Live status for every line on the given modes. Note: `elizabeth-line`, not the dead `tflrail`. */
export async function getLineStatus(
  modes = "tube,dlr,overground,elizabeth-line,tram",
): Promise<LineStatus[]> {
  // Thameslink is mode "national-rail" (25 operators share it), so it can't
  // ride the mode fetch — request the single line separately. If just that
  // request fails, show the TfL lines rather than an empty sidebar.
  const [modeLines, thameslink] = await Promise.all([
    tflFetch<LineStatus[]>(`/Line/Mode/${modes}/Status`, 60),
    tflFetch<LineStatus[]>(`/Line/thameslink/Status`, 60).catch(() => []),
  ]);
  return [...modeLines, ...thameslink];
}

/** Live arrival predictions for one or more comma-separated line ids. */
export function getLineArrivals(lineIds: string): Promise<Prediction[]> {
  return tflFetch(`/Line/${lineIds}/Arrivals`, 30);
}

/** Live arrivals at a single stop/station by NaPTAN id. */
export function getStopArrivals(stopId: string): Promise<Prediction[]> {
  return tflFetch(`/StopPoint/${stopId}/Arrivals`, 30);
}

/** Free-text station/stop search. */
export function searchStopPoints(
  query: string,
): Promise<{ matches: StopPoint[] }> {
  return tflFetch(`/StopPoint/Search/${encodeURIComponent(query)}`, 3600);
}
