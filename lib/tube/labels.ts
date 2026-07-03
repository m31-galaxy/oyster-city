import { atom } from "tldraw";

/**
 * Station labels hidden by decluttering (label-label overlap, lower priority
 * loses; interchanges outrank regular stations). Label rects are fixed in
 * PAGE space, so overlap is zoom-independent — these sets only change when
 * the station layout changes, never while panning/zooming. Two regimes:
 * `all` applies at zoom >= LABEL_ZOOM (every station labelled), `interOnly`
 * below it (only interchanges labelled, so fewer collisions).
 *
 * Held in a tldraw atom so the station components (fade in/out) and canCull
 * (a decluttered label shouldn't veto culling) react automatically.
 */
export const hiddenLabels = atom<{
  all: ReadonlySet<string>;
  interOnly: ReadonlySet<string>;
}>("hiddenLabels", { all: new Set(), interOnly: new Set() });
