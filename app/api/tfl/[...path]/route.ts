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
 * original query string and mirroring TfL's own cache directive.
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
    // Respect TfL's TTL — don't refresh faster than the data changes.
    next: { revalidate: 30 },
  });

  const body = await res.text();
  return new NextResponse(body, {
    status: res.status,
    headers: {
      "content-type": res.headers.get("content-type") ?? "application/json",
      // Pass TfL's cache directive through to the browser/CDN.
      "cache-control": res.headers.get("cache-control") ?? "public, max-age=30",
    },
  });
}
