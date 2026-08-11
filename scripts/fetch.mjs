/**
 * scripts/fetch.mjs
 * Daily AMX ingest. Run with:  npx tsx scripts/fetch.mjs
 * (tsx lets this plain-JS script import the TypeScript lib/normalize.ts,
 *  so the pipeline and the frontend share one mapping.)
 *
 * Behavior (per ARCHITECTURE.md):
 *  - Fetch the market snapshot with realistic browser headers.
 *  - On non-200 or an HTML body (Cloudflare challenge): record the failure
 *    in data/meta.json and exit non-zero so the Actions run shows red.
 *  - Normalize → write data/snapshots/{date}.json and data/latest.json;
 *    append one point per ISIN to data/history.json.
 *  - Idempotent: never overwrites an existing dated snapshot; never appends
 *    a duplicate date to a bond's history. Safe to re-run.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeSnapshot, toHistoryPoint } from "../lib/normalize.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
const SNAP_DIR = path.join(DATA, "snapshots");
const META = path.join(DATA, "meta.json");

const URL_SNAPSHOT = "https://amx.am/api/getMarketData/corporate_bonds";
const HEADERS = {
  accept: "*/*",
  "accept-language": "en-US,en;q=0.9",
  referer: "https://amx.am/en/market_data/corporate_bonds",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
};

/** Market date in Asia/Yerevan (UTC+4, no DST) — the 22:00 local run maps to today's local date. */
function yerevanDate() {
  return new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 10);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 1) + "\n", "utf8");
}

/** Record the failure in meta.json (kept from the last good run), then exit red. */
function fail(message) {
  const meta = readJson(META, { latestDate: null, dates: [], bondCount: 0 });
  meta.lastRunStatus = "error";
  meta.lastError = message;
  meta.lastRunAt = new Date().toISOString();
  writeJson(META, meta);
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

async function main() {
  const date = yerevanDate();
  console.log(`Ingest for market date ${date} (Asia/Yerevan)`);

  // ---- 1. Fetch, with a 30s timeout ----
  let text;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    const res = await fetch(URL_SNAPSHOT, { headers: HEADERS, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return fail(`HTTP ${res.status} from AMX snapshot endpoint`);
    text = await res.text();
  } catch (e) {
    return fail(`network error: ${e.message}`);
  }

  // ---- 2. Reject Cloudflare challenge pages (HTML instead of JSON) ----
  const head = text.trimStart().slice(0, 1);
  if (head !== "{" && head !== "[") {
    return fail(
      "response is not JSON (likely a Cloudflare challenge page). " +
      "See AMX_API_REFERENCE.md §3 for fallback options."
    );
  }

  // ---- 3. Parse + normalize ----
  let payload;
  try { payload = JSON.parse(text); } catch (e) { return fail(`invalid JSON: ${e.message}`); }

  const bonds = normalizeSnapshot(payload);
  if (bonds.length === 0) {
    return fail(
      "normalization produced 0 usable bonds — the guessed field names in lib/normalize.ts " +
      "probably do not match the real payload. Run the inspection command and paste the output into the chat."
    );
  }
  console.log(`Normalized ${bonds.length} bonds`);

  // ---- 4. Write snapshot + latest (never overwrite an existing dated snapshot) ----
  const snapshot = { date, fetchedAt: new Date().toISOString(), bonds };
  const snapFile = path.join(SNAP_DIR, `${date}.json`);
  if (fs.existsSync(snapFile)) {
    console.log(`Snapshot ${date}.json already exists — leaving it untouched (idempotent re-run).`);
  } else {
    writeJson(snapFile, snapshot);
  }
  writeJson(path.join(DATA, "latest.json"), readJson(snapFile, snapshot));

  // ---- 5. Append to history.json (skip ISIN+date pairs that already exist) ----
  const history = readJson(path.join(DATA, "history.json"), {});
  let appended = 0;
  for (const b of bonds) {
    const series = (history[b.isin] ??= []);
    if (!series.some((p) => p.d === date)) {
      series.push(toHistoryPoint(b, date));
      series.sort((a, z) => a.d.localeCompare(z.d));
      appended++;
    }
  }
  writeJson(path.join(DATA, "history.json"), history);

  // ---- 6. meta.json ----
  const meta = readJson(META, { dates: [] });
  const dates = Array.from(new Set([...(meta.dates ?? []), date])).sort();
  writeJson(META, {
    latestDate: date,
    dates,
    bondCount: bonds.length,
    lastRunStatus: "ok",
    lastError: null,
    lastRunAt: new Date().toISOString(),
  });

  console.log(`OK: wrote snapshot for ${date} (${bonds.length} bonds, ${appended} history points appended)`);
}

main();
