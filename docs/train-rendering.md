# Live train indicators — how positions are determined & rendered

> Handoff doc for the live "Mini-Metro-style" train markers on the Oyster City
> map. Rewritten 2026-07-02 after the accuracy overhaul (absolute-time
> trajectories). Line numbers drift — grep for the named symbols. For the
> measurement methodology and the numbers behind every design choice here, see
> `train-position-accuracy.md`.

## 1. What this feature does

Small coloured rectangles (`train` shapes) glide along each Tube/DLR/Overground/
Elizabeth line at the live position of every train, in **both** view modes:

- **Editable mode** — trains sit on the octilinear (45°/90°, Beck-style) connectors.
- **Geographic mode** — trains sit on the real OSM track curves, rotated to face
  along the track.

Positions come from TfL's **Arrivals** predictions (per-stop ETAs), refreshed
every 30s, with local trajectory-following between refreshes so trains move
continuously — across stations, with platform dwells and eased acceleration.

**Accuracy caveat:** TfL has *no* public train-position API; per-stop arrival
times are all we get, so the *along-segment* position is a kinematic estimate
between two known arrival times. The lateral placement (which line, which
segment, on the drawn geometry) is exact.

## 2. End-to-end data flow

```
TfL Unified API                     (ONE request per 30s for all ~20 lines)
  GET /Line/{id1,id2,…}/Arrivals
        │  via the same-origin proxy app/api/tfl/[...path]/route.ts
        │  (injects app_key server-side, next:{revalidate:30})
        │  client fetch uses cache:"no-store" (no browser-cache staleness)
        ▼
Prediction[]  (lib/tfl/types.ts) — demuxed by p.lineId
        │  deriveTrains() per line  (lib/tube/trains.ts) — PURE, no tldraw
        │  stitchTrains(prevStore, fresh) — carries exact step-0 starts across polls
        ▼
TrainRecord[]  { key, lineId, color, fetchMs,
                 steps: [{branchShapeId, segIndex, reversed, startMs, endMs}, …] }
        │  merged into trainStore ref (keyed by `${lineId}:${vehicleId}`)
        ▼
positionTrains()  (components/TubeMap.tsx) — runs on a throttled rAF loop
        │  trainPose(rec, Date.now()±blend) → {branch, segment, f}
        │  → page-space point via line geometry → create/update/remove shapes
        ▼
TrainShapeUtil  (components/shapes/TrainShapeUtil.tsx) — a coloured <div>
```

Two independent clocks, deliberately decoupled:
- **Data cadence** — a 30s `setInterval` poll rebuilds `trainStore`.
- **Visual cadence** — a `requestAnimationFrame` loop (throttled to ~10 fps)
  re-poses shapes from the current store.

## 3. The position model (lib/tube/trains.ts)

Everything follows from two measured facts (see the accuracy doc):

1. Arrivals payloads are **60–100s stale on receipt** (three cache layers +
   generation lag) and the staleness varies per poll — so positions are
   anchored to **`expectedArrival` (absolute wall-clock)**, never to
   "timeToStation at fetch time". `expectedArrival = timestamp + timeToStation`
   exactly, and TfL rarely revises it (median churn 0s).
2. Trains frequently cross a station between polls — so a record carries the
   whole resolved ladder as a **piecewise trajectory (`steps`)**, not one
   segment.

`deriveTrains()` per line, per poll:

1. **Group by `vehicleId`** (not unique across lines — key `${lineId}:${vehicleId}`).
2. **Ladder**: resolve each prediction's platform NaPTAN → station id
   (`naptanToHub`), dedup per station keeping the earliest `expectedArrival`
   (kills the terminus Platform-1/2 double), sort ascending. `ladder[0]` = next stop.
3. **Learn per-segment run times**: consecutive ladder gaps (0 < d ≤ 360s) are
   TfL's own predicted run time for that directed segment; the cross-vehicle
   **median** is the estimate (83–94% coverage; distance ÷ 10 m/s clamped
   25–240s as fallback).
4. **Resolve the current segment**: find a branch containing `ladder[0]` and
   `ladder[1]` at different indices; direction = the ladder's own index order.
   Junction-relocation and single-prediction terminus fallbacks as before
   (see git history / code comments).
5. **Build `steps`**: step 0 = the current segment, `endMs = ea(next)`,
   `startMs` backed out via the run-time table (then overwritten by
   `stitchTrains` with the previous poll's exact value when known). Each
   further ladder pair becomes a step with **exact absolute times at both
   ends**; non-adjacent pairs (an unresolved intermediate stop) are subdivided
   proportionally to per-segment run times. Steps extend ≥180s past fetch
   (cap 10), so trains keep moving through missed polls.

`trainPose(rec, nowMs)` — pure kinematics, no state: walk to the active step;
hold at the platform for the dwell (30s, ≤25% of the window); then move with a
**smoothstep** profile (zero velocity at both ends — eases out of and into
stations), arriving exactly at `endMs`. Returns
`{branchShapeId, segIndex, reversed, f, moving}`.

`trainTimeAt(rec, pose)` — the inverse: when does this trajectory pass that
pose? Used for time-domain blending (below).

`stitchTrains(prevStore, fresh)` — copies the previous record's window start
into the fresh record's synthetic step-0 start (same branch+segment+direction),
clamped to a ≥15s window. Removes the dominant residual warp (~p90 300m).

## 4. Rendering — `positionTrains()` (components/TubeMap.tsx)

Runs every rAF tick (throttled to `TRAIN_TICK_MS`) — plus **event-driven
passes whenever line geometry moves faster than the ambient tick**, so trains
stay glued to the line instead of catching up in visible ~100ms hops:

- the station-drag side effect re-poses trains **in the same synchronous
  batch** that redraws the dragged lines, filtered via
  `positionTrains(affectedBranchIds)` (a filtered pass updates existing shapes
  only — create/delete must see every key, so they stay with the full pass);
- the mode-morph tween calls `positionTrains()` after drawing each frame and
  once after settling.

Keeping 600+ per-frame train updates within the frame budget (measured: the
naive version cost ~30ms/frame vs ~11ms for the line tween alone; now ~2-4ms
on top of it):

- **`morphPointAt`** — a direct single-point evaluator of the octi/curve
  blend (O(log n), zero allocation) instead of building each train's blended
  polyline via `morphSegmentPoints` + `pointAlong` per frame. Exact at both
  settle states and always on the drawn line; only the mid-tween
  parameterization differs sub-pixel.
- **Heading lives in the shape's top-level `rotation`, not props** (x/y
  counter-offset by `R(rot)·(w/2,h/2)` since tldraw rotates about the
  top-left). Props never change during motion, so the memoized shape
  component renders once per train — per-frame React re-renders were the
  dominant cost. Updates go through one batched `updateShapes` call.
- **Perceptual gating** — skip updates under ~0.5 *screen* px
  (zoom-adaptive; invisible by construction) and skip trains off-screen both
  before and after the move (positions are absolute, so they're exact when
  they re-enter view).

And for **pan/idle** performance:

- **Culling is enabled for trains and stations** (previously `canCull=false`
  on both, so ~95% of the map was painted while zoomed in — 62 shapes hidden
  vs 1300+ now). Train bounds are exact post-rotation-refactor. Station
  geometry stays the 11×11 marker only (labels are invisible to selection
  boxes, snapping, and hit-testing); the overflowing HTML label is protected
  from edge-pop by a custom `canCull` that vetoes the cull while the label's
  (generously estimated) page rect still intersects the viewport.
- **No-op ticks touch nothing**: `positionTrains` collects work read-only and
  only opens `editor.run` (and geo mode's readonly lift, previously a 10Hz
  instance-state write even when idle) when there is something to write.

For each record:

1. **Blend bookkeeping.** When a record's `fetchMs` changes (fresh poll), the
   correction is converted to a **time offset**: `trainTimeAt(newRec, lastPose)`
   gives the moment the new trajectory passes the currently-displayed pose;
   display time starts there and decays to real time over
   `max(TRAIN_BLEND_MS, 2×|offset|)` with a **smoothstep** decay (peak slope
   1.5 — easeInOutCubic's is 3, which would run display time backward;
   caught by the monotonicity unit check). Guarantees: display
   speed stays within 0.25×–1.75× of real, trains **never move backward** and
   **never leave the track** during corrections. If the new trajectory never
   visits the displayed pose (reroute, branch switch, |offset| > 90s), fall
   back to the old decaying 2D point offset. Both are skipped during the
   mode-morph (the whole line is already moving).
2. `pose = trainPose(rec, Date.now() + timeOff·decay)`.
3. Resolve the pose's station pair to **live** centres via
   `shapeIdFor.get(...)` → `getShapePageBounds().center` (tracks drags and the
   mode-morph for free), then compute the page-space **point + tangent** with
   the geometry matching how the line is currently drawn:
   - **geo**: `pointAlongArc(lineSegGeo[i], segProfiles[i].arc, fFwd)` (arc-table
     lookup on the projected OSM curve; falls back `pointAlong` → `straightAt`).
   - **editable**: `octiPointAt(cA, cB, fFwd)`.
   - **morphing**: `pointAlong(morphSegmentPoints(cA, cB, profile, morphFrac), fFwd)`.
   (`fFwd = reversed ? 1−f : f` — segment indices name the forward pair.)
4. **Rotation** = `atan2(tangent)` → `props.rot`, applied as a CSS rotation
   about the div centre (tldraw's shape `rotation` pivots the top-left corner).
5. **Shape CRUD** inside `editor.run(fn, {ignoreShapeLock:true})`: create
   missing (`isLocked:true`), update moved (skip <0.2px / 0.02rad), delete keys
   no longer in the store. Geo mode's `isReadonly` is lifted for the batch and
   restored in `finally`.

## 5. File map & refs

| File | Responsibility |
|---|---|
| `lib/tube/trains.ts` | Pure derivation + kinematics: `deriveTrains`, `stitchTrains`, `trainPose`, `trainTimeAt`. Unit-testable against recorded arrivals. |
| `components/TubeMap.tsx` | State + rendering: refs, poll loop, rAF loop, `positionTrains`, geometry helpers, mode-morph. |
| `components/shapes/TrainShapeUtil.tsx` | The `train` tldraw shape (rectangle, `canCull=false`, CSS-rotated). |
| `app/api/tfl/[...path]/route.ts` | Server proxy (hides app_key, `revalidate: 30`). |
| `lib/tube/network.ts` / `scripts/build-tube-data.mjs` | Projected network + `naptanToHub`. |

Refs in `TubeMap.tsx` (populated in `handleMount`): `shapeIdForRef`,
`branchesForLineRef`, `branchStationIdsRef`, `segProfilesRef`, `lineSegGeo`,
`naptanToHubRef`, `stationPosRef`, `lineColorRef`, `trainStore`, `trainShapes`,
`morphFracRef` — as before. `trainRender` now holds per-train blend state
`{x, y, fetchMs, pose, timeOff, offX, offY, offStart, blendMs}`.

## 6. Lifecycle

- **Poll `useEffect`** (`[mounted]`): waits (200ms retries) for the editor +
  branch registry, then a 30s `setInterval`. ONE fetch for all line ids
  (comma path). On any failure the previous store is **kept** — trajectories
  cover the gap and trains glide on (previously, failed lines had their trains
  deleted and re-created).
- **rAF `useEffect`**: single self-scheduling loop, throttled to
  `TRAIN_TICK_MS`; cleanup cancels it and the morph tween's rAF.
- **Mode-morph interplay**: `applyMode` writes `morphFracRef` each frame;
  `positionTrains` picks the matching geometry and skips blending while
  morphing. Unchanged from before.
- **Dev hook:** `window.__trainTick` = `positionTrains` (dev only) — the
  preview pauses rAF (§8).

## 7. Constants / tuning knobs

| Constant | File | Value | Effect |
|---|---|---|---|
| `TRAIN_POLL_MS` | TubeMap.tsx | 30000 | data refresh. Don't go lower (TfL TTL + rate limits). |
| `TRAIN_TICK_MS` | TubeMap.tsx | 100 | ~10 fps reposition. |
| `TRAIN_BLEND_MS` | TubeMap.tsx | 1500 | min correction-ease window (auto-widens: `2×|timeOff|`). |
| `TRAIN_BLEND_MAX_MS` | TubeMap.tsx | 90000 | corrections beyond this jump via the 2D fallback. |
| `STEP_HORIZON_MS` / `MAX_STEPS` | trains.ts | 180s / 10 | trajectory coverage past fetch. |
| `DWELL_MS` / `DWELL_MAX_FRAC` | trains.ts | 30s / 0.25 | platform hold (measured median ~44s incl. terminus/sampling inflation). |
| `MIN_STEP_WINDOW_MS` | trains.ts | 15s | floor for a stitched step-0 window. |
| `SEG_SPEED_MPS`, `MIN/MAX_SEG_SECONDS`, `LADDER_MAX_SECONDS` | trains.ts | 10, 25/240, 360 | run-time fallback + learning filter. |
| `SHOWN_LINES` | TubeMap.tsx | `null` | `null` = whole network (~600 trains). |

## 8. How to verify (preview gotchas)

The Claude preview **pauses `requestAnimationFrame`** and throttles background
timers hard. Techniques that work:

- `window.__trainTick()` forces one `positionTrains` pass.
- **Virtual time**: monkey-patch `Date.now = () => real + offset`, advance
  `offset` in a synchronous loop calling `__trainTick()` — simulates minutes of
  motion deterministically (blend decay uses `performance.now`, so it stays
  frozen — corrections won't decay under virtual time).
- **Mode-morph**: monkey-patch `requestAnimationFrame` to a capped
  `queueMicrotask` shim before clicking the toggle (bounded — the train loop
  reschedules forever), restore after.
- **Attachment check**: parse each `tube-line`'s `d` (+ shape.x/y), measure
  each train centre to the nearest same-colour polyline — ~0px in steady
  state; up to ~40px transiently while a 2D-fallback blend decays.
- `preview_console_logs` can replay a stale error buffer; trust
  `npm run build` / `window.editor` presence.
- The derivation is pure: replay recorded `Prediction[]` through
  `deriveTrains`/`trainPose` and assert on records directly (that's how the
  accuracy numbers were produced — see `train-position-accuracy.md`).

## 9. Known limitations & approximations

1. **Within-segment position is a kinematic guess** between two known arrival
   times (dwell + smoothstep). TfL revises predictions as trains approach
   (p90 31–55s) — presented as gentle speed variation by the time blend.
2. **Ladder staleness (~60–100s)** — which segment a train is on can lag
   reality by ~1 stop; the trajectory model hides the seam.
3. **Terminus pinning** — ~8% of ladders genuinely end (approaching
   terminus); the train pins at the last stop until return-trip predictions
   appear.
4. **Overlapping trains stack** (no lateral offset).
5. **National-Rail-only stops** (`910G*`) don't resolve → those trains skipped.
6. **Prediction-set churn**: not every train emits predictions every poll;
   records are ephemeral (reconciled by key each poll; store kept wholesale on
   poll failure).
7. **`currentLocation`/`direction` fields** are deliberately unused for
   positioning (direction comes from the ladder order).
8. ~0.1% of steps have degenerate short windows (TfL's own ea deltas across a
   subdivided pair) → a brief visible hurry; consistent across polls so no warp.

## 10. Where to focus next

See `train-position-accuracy.md` §5 for the ranked list (app_key, persistent
run-time table, TrackerNet, timetable prior, currentLocation dwell anchoring,
stacked-train fan-out). All three previously deferred perf items are now
done: rot-in-props, per-train morph-tick allocations, and culling (§4).

## 11. Related commits

- `9f30ddf` Add live train-position indicators (Mini-Metro style)
- `410e6cb` Emit a naptan->hub map for resolving live arrivals to stations
- `b9f2eaa` Fix train drop at branch junctions; tidy lifecycle + geo perf
- `ef35202` Smooth train motion across live-data refreshes
- `53cf63c` Learn per-segment train run times from TfL predictions
- (this session) Absolute-time ladder trajectories: expectedArrival anchoring,
  stitching, dwell+smoothstep kinematics, time-domain blending, single-request
  poll.
