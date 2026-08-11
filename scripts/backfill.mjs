/**
 * scripts/backfill.mjs
 * One-time (and safe-to-repeat) history builder. Run via workflow_dispatch or:
 *   npx tsx scripts/backfill.mjs
 *
 * For every ISIN in data/latest.json:
 *   1. GET https://amx.am/api/getInstrument/{ISIN}
 *   2. Merge its full per-day series into data/history.json (idempotent —
 *      existing ISIN+date points are never duplicated or overwritten).
 *   3. Capture coupon / frequency / amount-outstanding / issuer / true
 *      last-trade date into data/enrichment.json.
 *
 * Politeness (per AMX_API_REFERENCE.md §3): ≤ 1 request/second, one commit at the end.
 * If latest.json is missing, run the ingest workflow first.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { instrumentHistory, instrumentEnrichment } from "../lib/normalize.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");

const HEADERS = {
  accept: "*/*",
  "accept-language": "en-US,en;q=0.9",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 1) + "\n", "utf8");
}

/** Fetch one instrument's raw payload, or null on any failure (logged, not thrown). */
async function fetchInstrument(isin) {
  const url = `https://amx.am/api/getInstrument/${isin}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    const res = await fetch(url, {
      headers: { ...HEADERS, referer: `https://amx.am/en/instrument_page/${isin}/historical` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) { console.warn(`  ! ${isin}: HTTP ${res.status}`); return null; }
    const text = await res.text();
    const head = text.trimStart().slice(0, 1);
    if (head !== "{" && head !== "[") { console.warn(`  ! ${isin}: non-JSON (Cloudflare?)`); return null; }
    return JSON.parse(text);
  } catch (e) {
    console.warn(`  ! ${isin}: ${e.message}`);
    return null;
  }
}

async function main() {
  const latest = readJson(path.join(DATA, "latest.json"), null);
  if (!latest?.bonds?.length) {
    console.error("No data/latest.json with bonds — run the ingest workflow first.");
    process.exit(1);
  }

  const isins = [...new Set(latest.bonds.map((b) => b.isin))];
  console.log(`Backfilling ${isins.length} instruments (≤1 req/s)...`);

  const history = readJson(path.join(DATA, "history.json"), {});
  const enrichment = readJson(path.join(DATA, "enrichment.json"), {});

  let ok = 0, failed = 0, pointsAdded = 0;

  for (let i = 0; i < isins.length; i++) {
    const isin = isins[i];
    process.stdout.write(`[${i + 1}/${isins.length}] ${isin} ... `);

    const payload = await fetchInstrument(isin);
    if (!payload) { failed++; await sleep(1000); continue; }

    // ---- merge history (append-only; never overwrite an existing dated point) ----
    const series = (history[isin] ??= []);
    const seen = new Set(series.map((p) => p.d));
    let added = 0;
    for (const pt of instrumentHistory(payload)) {
      if (!seen.has(pt.d)) { series.push(pt); seen.add(pt.d); added++; }
    }
    series.sort((a, z) => a.d.localeCompare(z.d));
    pointsAdded += added;

    // ---- capture enrichment metadata ----
    enrichment[isin] = instrumentEnrichment(payload);

    ok++;
    console.log(`ok (+${added} points)`);
    await sleep(1000); // politeness throttle
  }

  writeJson(path.join(DATA, "history.json"), history);
  writeJson(path.join(DATA, "enrichment.json"), enrichment);

  console.log(
    `\nDone. ${ok} ok, ${failed} failed, ${pointsAdded} history points added across all ISINs.`
  );
  // Non-fatal if some instruments failed — partial backfill still commits what succeeded.
}

main();
