// app/api/history/[isin]/route.ts
// Serves one ISIN's history series. history.json is ~5 MB — far too large to ship
// to the browser with the page, so the detail-panel sparkline fetches just the one
// series it needs from here. The file is read once per server instance and cached.
// (next.config.mjs → outputFileTracingIncludes makes sure Vercel bundles the file.)
import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import type { HistoryPoint } from "@/lib/normalize";

export const runtime = "nodejs";

let cache: Record<string, HistoryPoint[]> | null = null;

function loadHistory(): Record<string, HistoryPoint[]> {
  if (!cache) {
    const file = path.join(process.cwd(), "data", "history.json");
    cache = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, HistoryPoint[]>;
  }
  return cache;
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ isin: string }> },
) {
  const { isin } = await ctx.params; // Next 15 passes params as a Promise
  const series = loadHistory()[isin] ?? [];
  return NextResponse.json(series, {
    // Data changes at most once a day; let the CDN cache it for a while.
    headers: { "Cache-Control": "public, max-age=300, s-maxage=3600" },
  });
}
