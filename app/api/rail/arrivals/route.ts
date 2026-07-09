import { NextResponse } from "next/server";
import type { Prediction } from "@/lib/tfl/types";
import { getRailArrivals, type RailSource } from "@/lib/rail/arrivals";

/**
 * Live National Rail arrivals for the map's NR lines (see lib/rail/lines.ts),
 * in the same Prediction[] shape as the TfL Arrivals proxy — the client
 * merges the two streams before deriving trains. The upstream that produced
 * the data (darwin | fixture | disabled) rides the x-rail-source header for
 * the debug panel.
 *
 * Server-side for the same reasons as /api/tfl: the Darwin token stays
 * secret, and the in-process memo below coalesces all visitors onto one
 * upstream board sweep per interval (a dozen LDBWS calls each ~30s, far
 * inside the registered usage caps).
 */
const MEMO_MS = 25_000;
let memo: { t: number; body: Prediction[]; source: RailSource } | null = null;
let inflight: Promise<unknown> | null = null;

export const dynamic = "force-dynamic";

export async function GET() {
  if (!memo || Date.now() - memo.t >= MEMO_MS) {
    // Coalesce concurrent cold-cache requests onto one upstream sweep.
    inflight ??= getRailArrivals()
      .then(({ source, predictions }) => {
        memo = { t: Date.now(), body: predictions, source };
      })
      .finally(() => {
        inflight = null;
      });
    try {
      await inflight;
    } catch {
      // Upstream failure with no previous memo: serve empty — the client
      // keeps NR trains alive off its previous store anyway.
      if (!memo) memo = { t: Date.now(), body: [], source: "darwin" };
    }
  }
  return NextResponse.json(memo!.body, {
    headers: {
      "cache-control": "public, max-age=25",
      "x-rail-source": memo!.source,
    },
  });
}
