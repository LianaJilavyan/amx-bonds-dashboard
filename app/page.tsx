// app/page.tsx
// Server Component. Reads the three SMALL committed JSON files at build time,
// merges enrichment.json into each bond, derives NMC / staleness / years-to-
// maturity, and hands a ready-to-render array to the client dashboard.
//
// Why import here instead of an /api/latest route: these files total ~120 KB, so
// importing them at build time (per ARCHITECTURE.md) is simplest and needs no
// route. Only history.json (5 MB) is served by a route — see app/api/history.
//
// IMPORTANT merge rule: latest.json already carries English issuer names
// (short_name_en). enrichment.json's issuer is Armenian. We KEEP the English one
// for the UI/issuer search and only pull coupon / freq / outstanding / last_trade
// (and maturity as a fallback) from enrichment. Staleness uses enrichment's
// last_trade — the true last-trade date — not the snapshot's session date.

import type { Bond, Enrichment } from "@/lib/normalize";
import { isNmc } from "@/lib/normalize";
import type { UiBond, Meta } from "@/app/types";
import Dashboard from "@/app/Dashboard";

import latest from "@/data/latest.json";
import enrichment from "@/data/enrichment.json";
import metaJson from "@/data/meta.json";

// The imported JSON is typed loosely by TS; assert the shapes we produced upstream.
const latestData = latest as unknown as { date: string; fetchedAt: string; bonds: Bond[] };
const enrichmentData = enrichment as unknown as Record<string, Enrichment>;
const meta = metaJson as unknown as Meta;

/** Whole calendar days between two YYYY-MM-DD dates (a - b). */
function daysBetween(a: string, b: string): number {
  const ms = Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z");
  return Math.round(ms / 86_400_000);
}

/** Years from `from` to a maturity date (may be negative if already matured). */
function yearsTo(maturity: string, from: string): number | null {
  if (!maturity) return null;
  const ms = Date.parse(maturity + "T00:00:00Z") - Date.parse(from + "T00:00:00Z");
  if (Number.isNaN(ms)) return null;
  return ms / (365.25 * 86_400_000);
}

function buildBonds(): UiBond[] {
  const latestDate = meta.latestDate || latestData.date;

  return latestData.bonds.map((b): UiBond => {
    const e = enrichmentData[b.isin];

    // Enrichment fills the fields the snapshot can't know.
    const merged: Bond = {
      ...b,
      coupon: e?.coupon ?? b.coupon,
      freq: e?.freq ?? b.freq,
      outstanding_amd: e?.outstanding_amd ?? b.outstanding_amd,
      last_trade: e?.last_trade ?? b.last_trade, // TRUE last-trade date
      maturity: b.maturity || (e?.maturity ?? ""), // keep snapshot maturity, fall back
      // issuer: intentionally NOT overwritten — keep the English snapshot name.
    };

    const daysSinceTrade =
      merged.last_trade ? daysBetween(latestDate, merged.last_trade) : null;

    return {
      ...merged,
      isNmc: isNmc(merged),
      daysSinceTrade,
      years: yearsTo(merged.maturity, latestDate),
    };
  });
}

export default function Page() {
  const bonds = buildBonds();
  return <Dashboard bonds={bonds} meta={meta} />;
}
