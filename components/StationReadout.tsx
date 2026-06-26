"use client";

import { useEffect, useState } from "react";
import { onStationSelect, type SelectedStation } from "@/lib/tube/selection";

/**
 * Sidebar readout of the currently tapped station. Proves the canvas →
 * React loop; the live-arrivals panel will hang off this selection next.
 */
export default function StationReadout() {
  const [station, setStation] = useState<SelectedStation | null>(null);
  useEffect(() => onStationSelect(setStation), []);

  return (
    <div className="readout">
      {station ? (
        <>
          <span className="readout-label">Selected station</span>
          <strong className="readout-name">{station.name}</strong>
        </>
      ) : (
        <span className="readout-hint">Tap a station on the map →</span>
      )}
    </div>
  );
}
