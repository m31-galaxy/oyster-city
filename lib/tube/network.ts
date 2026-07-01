import network from "./network.generated.json";

// The complete network is generated from the TfL Unified API by
// scripts/build-tube-data.mjs (geographic [lon,lat] coordinates). Here we
// project it once into canvas coordinates for the tldraw renderer.
//
// Layout is geographic, not Beck-schematic: full open-data schematic
// coordinates don't exist (TfL's are geographic; the schematic artwork is
// copyright). To refresh the data, re-run the generator. To re-style as a true
// schematic later, this projection is the single place to change.

/** Width (in canvas units) the projected map is scaled to. Tunes marker density. */
const TARGET_WIDTH = 5000;

interface RawLine {
  id: string;
  name: string;
  color: string;
  points: [number, number][];
  stationIds: string[];
  /** OSM-derived track curve as [lon,lat] (added by add-osm-curves.mjs). */
  geoPath?: [number, number][];
  /** Per-station-pair OSM curves as [lon,lat]; segment i joins stationIds[i]..[i+1]. */
  geoSegments?: ([number, number][] | null)[];
}
interface RawStation {
  id: string;
  name: string;
  lat: number;
  lon: number;
  interchange: boolean;
  color: string;
}
interface RawNetwork {
  lines: RawLine[];
  stations: RawStation[];
  /** Platform NaPTAN id -> our station id, for resolving live arrivals. */
  naptanToHub?: Record<string, string>;
}

const data = network as unknown as RawNetwork;

export interface TubeLinePath {
  id: string;
  name: string;
  color: string;
  points: [number, number][];
  /** Ordered station ids (aligned with `points`) this line passes through. */
  stationIds: string[];
  /** Projected OSM track curve (canvas coords); empty if unavailable. */
  geoPoints: [number, number][];
  /** Projected per-station-pair OSM curves (canvas); segment i joins stationIds[i]..[i+1]. */
  geoSegments: ([number, number][] | null)[];
}

export interface TubeStation {
  id: string;
  name: string;
  cx: number;
  cy: number;
  /** Geographic position (used for distance-based train run-time estimates). */
  lon: number;
  lat: number;
  interchange: boolean;
  labelPos: string;
  color: string;
}

export interface TubeNetwork {
  lines: TubeLinePath[];
  stations: TubeStation[];
  bounds: { w: number; h: number };
  /** Platform NaPTAN id -> our station id, for resolving live arrivals. */
  naptanToHub: Record<string, string>;
}

let cached: TubeNetwork | null = null;

/** Build (once) the projected network in canvas coordinates. */
export function getTubeNetwork(): TubeNetwork {
  if (cached) return cached;

  let lonMin = Infinity,
    lonMax = -Infinity,
    latMin = Infinity,
    latMax = -Infinity;
  const consider = (lon: number, lat: number) => {
    lonMin = Math.min(lonMin, lon);
    lonMax = Math.max(lonMax, lon);
    latMin = Math.min(latMin, lat);
    latMax = Math.max(latMax, lat);
  };
  for (const l of data.lines) for (const [lon, lat] of l.points) consider(lon, lat);
  for (const l of data.lines)
    if (l.geoPath) for (const [lon, lat] of l.geoPath) consider(lon, lat);
  for (const s of data.stations) consider(s.lon, s.lat);

  // Equirectangular projection with longitude compressed by cos(latitude) so
  // London keeps its true proportions. Y is flipped so north is up.
  const kx = Math.cos((((latMin + latMax) / 2) * Math.PI) / 180);
  const spanX = (lonMax - lonMin) * kx || 1;
  const scale = TARGET_WIDTH / spanX;
  const project = (lon: number, lat: number): [number, number] => [
    (lon - lonMin) * kx * scale,
    (latMax - lat) * scale,
  ];

  const lines: TubeLinePath[] = data.lines.map((l) => ({
    id: l.id,
    name: l.name,
    color: l.color,
    points: l.points.map(([lon, lat]) => project(lon, lat)),
    stationIds: l.stationIds,
    geoPoints: (l.geoPath ?? []).map(([lon, lat]) => project(lon, lat)),
    geoSegments: (l.geoSegments ?? []).map((seg) =>
      seg ? seg.map(([lon, lat]) => project(lon, lat)) : null,
    ),
  }));

  const stations: TubeStation[] = data.stations.map((s) => {
    const [cx, cy] = project(s.lon, s.lat);
    return {
      id: s.id,
      name: s.name,
      cx,
      cy,
      lon: s.lon,
      lat: s.lat,
      interchange: s.interchange,
      labelPos: "E",
      color: s.color,
    };
  });

  cached = {
    lines,
    stations,
    bounds: { w: TARGET_WIDTH, h: (latMax - latMin) * scale },
    naptanToHub: data.naptanToHub ?? {},
  };
  return cached;
}
