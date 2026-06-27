import TubeMap from "@/components/TubeMap";
import StationReadout from "@/components/StationReadout";
import CollapsibleSidebar from "@/components/CollapsibleSidebar";
import { getLineStatus } from "@/lib/tfl/client";
import { lineColour } from "@/lib/tfl/lines";
import type { LineStatus } from "@/lib/tfl/types";

export default async function Home() {
  let lines: LineStatus[] = [];
  let error: string | null = null;

  try {
    lines = await getLineStatus();
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to load line status";
  }

  return (
    <main className="layout">
      <CollapsibleSidebar>
        <h1>Oyster City</h1>
        <p className="tagline">Live London transport — a TfL Go for the web.</p>

        <StationReadout />

        <section>
          <h2>Line status</h2>
          {error && (
            <p className="error">
              Couldn&rsquo;t load live status. Set <code>TFL_APP_KEY</code> in{" "}
              <code>.env.local</code> (see <code>.env.example</code>).
            </p>
          )}
          <ul className="lines">
            {lines.map((line) => {
              const status = line.lineStatuses[0];
              const good = status?.statusSeverity === 10;
              return (
                <li key={line.id}>
                  <span
                    className="swatch"
                    style={{ background: lineColour(line.id) }}
                  />
                  <span className="line-name">{line.name}</span>
                  <span className={good ? "status good" : "status bad"}>
                    {status?.statusSeverityDescription ?? "Unknown"}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>

        <footer className="attribution">
          Powered by TfL Open Data. Line geometry © OpenStreetMap contributors.
        </footer>
      </CollapsibleSidebar>

      <div className="map">
        <TubeMap />
      </div>
    </main>
  );
}
