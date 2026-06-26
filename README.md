# Oyster City

A browser-based equivalent of TfL's **TfL Go** app — live London transport
arrivals, line status, journey planning and an interactive schematic Tube map —
at [oyster.city](https://oyster.city).

Built with **Next.js (App Router) + React + tldraw**, using the public
[TfL Unified API](https://api.tfl.gov.uk).

## Getting started

```bash
npm install
cp .env.example .env.local   # then add your TfL key
npm run dev                  # http://localhost:3000
```

Get a free API key at the [TfL API portal](https://api-portal.tfl.gov.uk).
Auth is the `app_key` query param **only** — the old `app_id` is deprecated and
not required. The app runs without a key but live status will show an error
until one is set.

## Architecture

```
app/
  layout.tsx                 root layout
  page.tsx                   home — server-renders live line status + the map
  globals.css                layout styles
  api/tfl/[...path]/route.ts generic TfL proxy (keeps the key server-side)
components/
  TubeMap.tsx                'use client' tldraw island (read-only canvas)
lib/tfl/
  client.ts                  server-only typed TfL client
  types.ts                   trimmed Unified API response types
  lines.ts                   official line colours
```

**Two ways to reach TfL, by design:**

- **Server components** import `lib/tfl/client.ts` and call the API directly —
  the key never leaves the server (`server-only` enforces this).
- **Client components** (e.g. tapping a station on the canvas) fetch the
  `/api/tfl/*` proxy route, which injects the key, dodges CORS, and mirrors
  TfL's cache TTL.

Caching mirrors TfL's per-response TTL (arrivals ≈ 30s, status ≈ 60s), so many
users share one upstream hit and we stay under the **500 req/min per key** limit.

## Key facts & gotchas (from research)

- **Auth:** `app_key` only; `app_id` is gone.
- **Rate limit:** 500 req/min per key (HTTP 429 over it). The per-response
  cache TTL is a *separate* number — respect it, don't poll faster.
- **Licensing:** TfL's transport-data T&Cs (NOT OGL v3.0). Commercial use is
  allowed; **"Powered by TfL Open Data" attribution is required.**
- **Deprecations:** mode `tflrail` → use `elizabeth-line`.
- **No Oyster/contactless balance or journey history via open data** — TfL Go
  does that through the user's *personal* account login, not any public API.
- **The schematic Tube-map layout is NOT in the API** — only geographic
  lat/long. Topological x/y positions come from a community dataset or are
  hand-authored; the official Tube-map artwork is copyrighted.

## Roadmap

- [ ] Custom `station` + `line-segment` tldraw shapes from a topological dataset
- [ ] Station-detail panel with live arrivals (via the proxy)
- [ ] Journey planner (`/Journey/JourneyResults`) with step-free preference
- [ ] Geographic mode (MapLibre GL) for walking/cycling + nearby stops
