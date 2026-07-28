import { NextRequest, NextResponse } from "next/server";

const TFL_BASE = "https://api.tfl.gov.uk";

/**
 * Generic server-side proxy for the TfL Unified API.
 *
 * Why a proxy and not direct browser calls:
 *  - Keeps the secret `app_key` on the server (never shipped to the client).
 *  - Sidesteps the Unified API's CORS restrictions for browser requests.
 *  - Lets us cache/coalesce so many users share one upstream hit, staying
 *    well under TfL's 500 req/min-per-key limit.
 *
 * Client components fetch e.g. `/api/tfl/Line/victoria/Arrivals`; this forwards
 * to `https://api.tfl.gov.uk/Line/victoria/Arrivals?app_key=…`, preserving the
 * original query string.
 *
 * Caching lives in EXACTLY ONE layer: the server-side data cache on the
 * upstream fetch (revalidate below), which is what coalesces visitors onto
 * a shared upstream hit. The response itself is no-store — TfL's own
 * `public, max-age=30` used to be passed through, and in production it
 * STACKED: browser cache (30s) on top of the CDN edge cache (observed
 * serving `age: 54` stale-while-revalidate HITs) on top of the data cache
 * (~30s serve-stale window) left deployed clients polling minute-old
 * arrivals. Trains anchor trajectories to absolute prediction times, so
 * stale anchors put every train visibly in the wrong place — while dev,
 * with no CDN in front, stayed fresh. (Diagnosed 2026-07-28 by fingerprint-
 * probing prod vs local: prod served one identical payload for ~55s.)
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;

  const search = new URLSearchParams(req.nextUrl.searchParams);
  const key = process.env.TFL_APP_KEY;
  if (key) search.set("app_key", key);

  const qs = search.toString();
  const upstream = `${TFL_BASE}/${path.map(encodeURIComponent).join("/")}${qs ? `?${qs}` : ""}`;

  const res = await fetch(upstream, {
    headers: { Accept: "application/json" },
    // The one shared cache (see header comment). 15s halves the average
    // serve-stale-while-revalidating age prod clients see, and even the
    // busiest URL (the all-lines Arrivals sweep) refreshes ≤6x/min —
    // nowhere near the key's 500 req/min.
    next: { revalidate: 15 },
  });

  const body = await res.text();
  return new NextResponse(body, {
    status: res.status,
    headers: {
      "content-type": res.headers.get("content-type") ?? "application/json",
      // NEVER cached at the browser or CDN — staleness must not stack on
      // the data cache above (see header comment).
      "cache-control": "private, no-store",
    },
  });
}
