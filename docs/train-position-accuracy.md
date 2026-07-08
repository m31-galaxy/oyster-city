# Train-position accuracy — measurements & plan

> Companion to `train-rendering.md`. Written 2026-07-02 after a monitored hour
> of live TfL Arrivals polls (victoria/central/northern/district, 20s cadence,
> 180 polls/line, 422k predictions, 37k poll-boundary comparisons) and a
> replay harness that runs the _production_ derivation code over the recording. Scripts live in the session scratchpad (`collect-arrivals.mjs`,
> `analyze-v2.mjs`, `diagnose-new.mjs`, `dwell-horizon.mjs`) — trivially
> recreatable; the methodology is documented here.

## 1. The problem

Every few dozen seconds (each 30s poll), all trains warped to corrected
positions. The pre-existing smoothing (stable learned run times + a 1.5s ease)
reduced but did not eliminate it.

## 2. What monitoring found

Method: record `/Line/{id}/Arrivals` every 20s for an hour (trimmed
predictions + response headers + local clocks); replay the derivation exactly
as the client runs it; at each poll boundary measure the distance between
where the _old_ record renders the train at the new poll's receipt time and
where the _new_ record puts it — the visible pre-blend warp.

Findings, in causal order:

1. **The data is far staler than the poll interval, and the staleness varies.**
   A response is a median **65s old at receipt (p90 94s, max ~111s)**:
   TfL's countdown snapshot lags ~30–40s, their Varnish CDN caches for 60s
   (`s-maxage=60`, observed `age: 0..60`), our proxy adds 0–30s
   (`revalidate: 30`), and the browser HTTP cache another 0–30s
   (`max-age=30` passthrough). The old model stamped `timeToStation` with
   `fetchTime = now`, so each poll re-based every train's clock by a random
   ±60s. **This was the warp.**
2. **`expectedArrival` = `timestamp + timeToStation` exactly** (0 violations
   in 422,013 predictions) — an absolute-time anchor immune to every cache
   layer. And TfL barely revises it: **median churn 0s, p90 31–55s** between
   polls for the same (vehicle, stop).
3. **Fixed-segment extrapolation pins trains at stations.** With accurate
   absolute time, 60–79% of extrapolations hit the f=1 clamp before the next
   poll: the train sits at the platform, then leaps a whole segment
   (median 350–850m) when the poll moves it on.
4. **Synthetic step starts disagree across polls.** A fresh record only knows
   its current segment's _end_ time; backing out the start via the run-time
   median contradicts what the previous poll knew exactly, adding a p90
   ~300m same-segment warp.
5. Segment run-time medians are stable (σ 6–12s per segment) and the ladder
   deltas cover 83–94% of segments. Observed platform dwell ("At X Platform"
   runs, n=2,904): median ~46s including terminus layovers and 20s sampling
   inflation — ~30s is the plausible non-terminus dwell.
6. **Client clocks are fine for absolute anchoring**: local time vs TfL's
   `date` response headers differed by 0.07–1.0s (p10–p90, incl. network
   latency) — no skew correction needed. (A pathologically wrong user clock
   would shift all trains uniformly; not worth defending against.)
7. **Anonymous rate limit is ~12 req/min sustained** (bursts of 14/30s
   already 429). The app's old poll burst 20 parallel line requests per 30s —
   silent 429s were dropping whole lines per poll (their trains froze, then
   over-corrected). `/Line/{id1,id2,…}/Arrivals` accepts all 20 ids in ONE
   request (~8MB raw, gzip-compressed on the wire) and works through the proxy.

## 3. What was implemented (2026-07-02)

In `lib/tube/trains.ts` (pure, replay-validated) + `components/TubeMap.tsx`:

1. **Absolute anchoring** — all positions derive from `expectedArrival`
   epochs vs `Date.now()`; `timeToStation`/fetch time are never a time base.
2. **Ladder trajectories** — `TrainRecord.steps`: the resolved prediction
   ladder as (branch, segment, direction, startMs, endMs) windows, covering
   ≥180s past fetch. `trainPose()` walks them between polls, so trains cross
   stations locally instead of pinning.
3. **Cross-poll stitching** — `stitchTrains()` carries the previous record's
   exact window start into the fresh record's synthetic step 0.
4. **Single-request poll** — one `/Line/…20 ids…/Arrivals` fetch per 30s with
   `cache: "no-store"` (kills the browser cache layer); on failure the old
   store is kept (trajectories cover the gap) instead of deleting the line's
   trains.
5. **Dwell + kinematics** — 30s hold at each platform (≤25% of window), then
   a smoothstep run (ease out of / into stations, zero velocity at both ends).
   Measured against linear motion this costs nothing (p90 warp 231m vs 240m —
   the dwell hold actually absorbs near-station churn).
6. **Time-domain correction blending** — a poll correction is converted into a
   time offset via `trainTimeAt()` (trajectory inversion) and decayed to zero
   over an adaptive window (`max(1.5s, 2×|offset|)`), keeping display speed
   within 0.25×–1.75× of real. Trains never slide backward and never leave
   the track for routine corrections; a 2D point-offset glide remains only as
   fallback for reroutes/branch switches (rare).

**Replay-validated result** (full-hour recording, n=37,184 poll boundaries,
old vs new pipeline):

| metric (per poll boundary) | old   | new       |
| -------------------------- | ----- | --------- |
| median warp                | 168m  | **0m**    |
| mean warp                  | 247m  | **72m**   |
| p90 warp                   | 564m  | **230m**  |
| boundaries with >50m warp  | 83.6% | **22.2%** |

Residual attribution (new pipeline): same-segment f disagreement from TfL's
own near-station revisions p90 204m (17.7% of boundaries >50m), cross-segment
placement 4.2%, trajectory-horizon exhaustion 0.3%.

Browser-verified: 561 trains, all exactly on their line in both modes
(median attachment 0px editable / 0.3px geo; transient offsets only while a
2D-fallback blend decays); motion median 0.7px/s (≈30km/h — realistic), 4
reversals in 37.5k steps (poll-fallback artifacts), max step 67px in 0.1% of
steps (degenerate short subdivided windows — TfL's own ea deltas; consistent
across polls so they don't warp, just briefly hurry).

## 3b. The residual "train warps across the screen" (fixed 2026-07-07)

A second monitored session (20 min, all lines, 2.5Hz sampling of live render
state + captured payloads) chased the remaining occasional cross-screen warp:
**3.3 glides/minute network-wide exceeded 150 page units** pre-fix. Four
mechanisms, all reproduced offline from captured polls:

1. **vehicleId collisions** — TfL vehicleIds are NOT unique; two physical
   trains regularly share one (small numeric ids recur per line). Their
   merged arrival ladder read as one train teleporting kilometres in seconds:
   direction flips, zero-width steps (a scripted 14-segment sprint in 1s of
   wall clock), cross-map warps. _Fix: per-vehicle ladder coherence filter —
   drop stops not physically reachable link-by-link (straight-line distance
   at 25 m/s, 45s slack), seeded from the stop matching the previous record
   (earliest consistent stop, 3-min tolerance) so the record keeps following
   the same physical train._
2. **Fragment-seam ambiguity** — "first fragment containing both stations"
   plus a terminus-style fallback at fragment endpoints made sparse/churning
   ladders oscillate between distant fragments (Wembley Park: 465 units;
   Elizabeth line: 350 units, provably not a collision — its ids are unique).
   _Fix: resolution hysteresis — prefer adjacency, then the previous record's
   fragment; single-stop fallback only at TRUE termini (one neighbour
   line-wide) or on the previous fragment; junction relocation prefers the
   approach step the train was already travelling._
3. **Head-drop teleports** — when the next stop's prediction disappears
   (served, or churn), the fresh step-0 reaches back only one segment; its
   backed-out start sits in the future and the pose pins at the segment's
   start station — a forward teleport past every intermediate station
   (measured 5.5km: Hayes & Harlington dropped, marker pinned at Hanwell).
   _Fix: `stitchTrains` prepends the previous trajectory's steps from its
   active one up to the fresh step-0's segment._
4. **Renderer safety net** — any residual 2D correction beyond 150 page
   units (genuine TfL-side relocations exist) now snaps instead of gliding:
   a blink, not a streak (`TRAIN_GLIDE_SNAP_UNITS`).

Offline replay of 5 captured polls (piccadilly/metropolitan/elizabeth,
~2,300 predictions each) through old vs new derivation: cross-poll implied
position jumps >800m fell **37 → 5** (max 7.7km → 1.0km, all survivors below
the snap threshold and consistent with data churn); records preserved rose
809 → 875 (fewer vehicles dropped at seams).

## 4. Remaining error budget (what the shown position can still be wrong by)

- **Prediction churn near stations** — TfL revises arrivals as trains
  approach (p90 31–55s). Irreducible from Arrivals alone; presented as gentle
  speed variation by the time blend. This is the accuracy floor of the feed.
- **Ladder freshness** — the ladder itself is 60–100s old, so _which_ segment
  a train is on can lag reality by ~1 stop right after it happens; the
  trajectory model hides the seam.
- **Within-segment shape** — position between two stations is a kinematic
  guess (dwell + smoothstep); TfL gives arrival times only.
- **Terminus behaviour** — ~8% of records' ladders genuinely end (train
  approaching terminus); trains pin at the last stop until predictions for
  the return trip appear under the same vehicleId.

## 5. Ranked future options (none blocking)

1. **Register a (free) TfL `app_key`** (`.env.local: TFL_APP_KEY=…`) —
   500 req/min headroom; removes all 429 risk. Zero code changes (proxy
   already injects it).
2. **Persist a per-segment run-time table** (EWMA in localStorage, or baked
   from a recorded day) — warms the first poll and covers segments with no
   train behind. Small win now that stitching exists.
3. **TrackerNet detailed predictions** (needs the app_key; new endpoint since
   2024, XML) — per-train track-code locations, i.e. actual _positions_ not
   just ETAs. The only data source that could beat expectedArrival anchoring.
   Big integration cost; revisit if within-segment truth ever matters.
4. **`/Line/{id}/Timetable/{stop}`** — scheduled inter-station run times
   (whole minutes). Coarser than the live-learned table; only useful as a
   build-time prior for uncovered segments.
5. **`currentLocation` anchoring** — "At X Platform"/"Between X and Y"
   strings could clamp the pose (e.g. force dwell while "At Platform").
   Moderate value; the strings update on the same stale payload, so gains are
   limited to dwell fidelity.
6. **Visual disambiguation** (unchanged from `train-rendering.md` §15):
   lateral offset for stacked trains, direction arrowheads.
