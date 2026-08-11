// app/page.tsx — Phase 1 placeholder. Confirms the pipeline state from data/meta.json.
// The full dashboard per STYLE_TEMPLATE.html replaces this in Phase 3.
import fs from "node:fs";
import path from "node:path";

type Meta = {
  latestDate: string | null;
  dates: string[];
  bondCount: number;
  lastRunStatus: string;
  lastError: string | null;
  lastRunAt: string | null;
};

function readMeta(): Meta | null {
  try {
    const p = path.join(process.cwd(), "data", "meta.json");
    return JSON.parse(fs.readFileSync(p, "utf8")) as Meta;
  } catch {
    return null;
  }
}

export default function Home() {
  const meta = readMeta();
  return (
    <main style={{ padding: 40, maxWidth: 720 }}>
      <h1 style={{ color: "#18164c" }}>AMX Corporate Bonds — pipeline status</h1>
      <p style={{ color: "#5d6472" }}>Phase 1: data pipeline only. Dashboard UI arrives in Phase 3.</p>
      {meta ? (
        <ul style={{ lineHeight: 1.9 }}>
          <li>Last run status: <b>{meta.lastRunStatus}</b></li>
          <li>Latest market date: <b>{meta.latestDate ?? "—"}</b></li>
          <li>Bonds in latest snapshot: <b>{meta.bondCount}</b></li>
          <li>Days accumulated: <b>{meta.dates.length}</b></li>
          {meta.lastError && <li style={{ color: "#9a152c" }}>Last error: {meta.lastError}</li>}
        </ul>
      ) : (
        <p>No data yet — run the <b>ingest</b> workflow from the Actions tab.</p>
      )}
    </main>
  );
}
