"use client";

import { useEffect, useState, type CSSProperties } from "react";

// Lightweight diagnostics overlay: a floating readout of the map's live
// internals (poll freshness, data sources, train/station/render counts,
// correction drift, pass timings). Deliberately unpolished — functionality
// over form until the app-wide UI sweep. Toggle via the corner button or
// the backtick key.

export interface DebugStats {
  poll: {
    agoS: number | null;
    everyS: number;
    tflOk: boolean;
    tflPreds: number;
    railSource: string;
    railStatus: string;
    railPreds: number;
  };
  trains: {
    records: number;
    shapes: number;
    onScreen: number;
    culled: number;
    byLine: [string, number][];
  };
  drift: {
    meanOffMs: number;
    maxOffMs: number;
    glides: number;
    maxGlidePx: number;
    resyncActive: boolean;
  };
  stations: {
    total: number;
    culled: number;
    labelsHiddenAll: number;
    labelsHiddenInter: number;
  };
  lines: { casings: number; cores: number };
  perf: { fps: number; fullMs: number; fineMs: number };
  camera: { zoom: number; mode: string; morph: number };
}

const panelStyle: CSSProperties = {
  position: "absolute",
  right: 12,
  bottom: 48,
  zIndex: 40,
  width: 300,
  maxHeight: "70vh",
  overflowY: "auto",
  padding: "10px 12px",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 11,
  lineHeight: 1.5,
  color: "#e4e4e7",
  background: "rgba(24, 24, 27, 0.92)",
  border: "1px solid #3f3f46",
  borderRadius: 8,
  whiteSpace: "pre-wrap",
};

const buttonStyle: CSSProperties = {
  position: "absolute",
  // Clear of tldraw's bottom-right watermark (96px wide + its margin),
  // which the license requires to stay visible and unobscured.
  right: 116,
  bottom: 12,
  zIndex: 40,
  padding: "4px 10px",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 11,
  color: "#52525b",
  background: "rgba(255, 255, 255, 0.85)",
  border: "1px solid #e4e4e7",
  borderRadius: 6,
  cursor: "pointer",
};

const h = (label: string) => (
  <div key={label} style={{ color: "#a1a1aa", marginTop: 6 }}>
    {label}
  </div>
);

export default function DebugPanel({
  collect,
}: {
  collect: () => DebugStats | null;
}) {
  const [open, setOpen] = useState(false);
  const [stats, setStats] = useState<DebugStats | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.key === "`") setOpen((o) => !o);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    setStats(collect());
    const iv = setInterval(() => setStats(collect()), 1000);
    return () => clearInterval(iv);
  }, [open, collect]);

  return (
    <>
      <button
        type="button"
        style={buttonStyle}
        onClick={() => setOpen((o) => !o)}
        title="Toggle debug panel (`)"
      >
        {open ? "debug ×" : "debug"}
      </button>
      {open && (
        <div style={panelStyle}>
          {!stats ? (
            "collecting…"
          ) : (
            <>
              {h("poll")}
              <div>
                {stats.poll.agoS === null
                  ? "no poll applied yet"
                  : `last applied ${stats.poll.agoS.toFixed(1)}s ago (every ${stats.poll.everyS}s)`}
              </div>
              <div>
                tfl: {stats.poll.tflOk ? "ok" : "FAILED"} ·{" "}
                {stats.poll.tflPreds} preds
              </div>
              <div>
                rail: {stats.poll.railSource} ({stats.poll.railStatus}) ·{" "}
                {stats.poll.railPreds} preds
              </div>

              {h("trains")}
              <div>
                records {stats.trains.records} · shapes {stats.trains.shapes} ·
                on-screen {stats.trains.onScreen} · culled {stats.trains.culled}
              </div>
              <div style={{ color: "#a1a1aa" }}>
                {stats.trains.byLine
                  .map(([id, n]) => `${id.slice(0, 12)} ${n}`)
                  .join(" · ")}
              </div>

              {h("drift (displayed vs predicted)")}
              <div>
                time-offset mean {(stats.drift.meanOffMs / 1000).toFixed(1)}s ·
                max {(stats.drift.maxOffMs / 1000).toFixed(1)}s
              </div>
              <div>
                2D glides {stats.drift.glides} · max{" "}
                {stats.drift.maxGlidePx.toFixed(0)}u
                {stats.drift.resyncActive ? " · RESYNC WINDOW" : ""}
              </div>

              {h("stations & lines")}
              <div>
                stations {stats.stations.total} · culled {stats.stations.culled}{" "}
                · labels hidden {stats.stations.labelsHiddenAll}+
                {stats.stations.labelsHiddenInter}
              </div>
              <div>
                line fragments {stats.lines.casings} · hollow cores{" "}
                {stats.lines.cores}
              </div>

              {h("perf & camera")}
              <div>
                fps {stats.perf.fps.toFixed(0)} · full pass{" "}
                {stats.perf.fullMs.toFixed(2)}ms · fine{" "}
                {stats.perf.fineMs.toFixed(2)}ms
              </div>
              <div>
                zoom {stats.camera.zoom.toFixed(2)} · {stats.camera.mode}
                {stats.camera.morph > 0 && stats.camera.morph < 1
                  ? ` · morph ${(stats.camera.morph * 100).toFixed(0)}%`
                  : ""}
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
