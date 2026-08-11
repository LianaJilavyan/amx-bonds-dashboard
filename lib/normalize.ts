/**
 * lib/normalize.ts
 * Bond type + mapping from the raw AMX API responses to our records.
 *
 * ✅ FINALIZED (Phase 2) against real payloads captured 2026-08-11:
 *   - GET /api/getMarketData/corporate_bonds   (snapshot: all bonds, one quote each)
 *   - GET /api/getInstrument/{ISIN}            (detail metadata + per-day market_data[])
 *
 * SNAPSHOT shape:
 *   { "data": [ {
 *       isin, ticker, maturity_date|null, short_name_en, short_name, cur, list,
 *       last_date,                                  // session/quote date, NOT last trade
 *       price: { bid, ask, close, ... },            // strings; "-" = missing
 *       yield: { bid, ask, close, ... }
 *   } ] }
 *
 * INSTRUMENT shape:
 *   { "data": {
 *       isin, ticker, issuer_name, currency, list_class,
 *       cpn_rate: "9.000000", cpn_frequency_en: "Semi-Annually",
 *       outst_volume: "2500000000.000000", per_value: "10000.000000",
 *       maturity_date, issue_date, first_payment_date, ...,
 *       market_data: [ {                            // one row PER DAY since listing
 *         order_date: "YYYY-MM-DD",
 *         trade_moment: "..."|null, trades_number: 0|N,
 *         close_price|null, close_yield|null,       // populated only on trade days
 *         best_bid_price, best_ask_price, best_bid_yield, best_ask_yield
 *       } ]
 *   } }
 *
 * Shared by scripts/fetch.mjs, scripts/backfill.mjs (run via `tsx`), and the frontend.
 */

export type Bond = {
  isin: string;
  ticker: string;
  issuer: string;
  ccy: "AMD" | "USD" | "EUR";
  price: number | null;      // bid, clean, % of par
  ask: number | null;
  close: number | null;
  ytm: number | null;        // bid yield %
  ytm_ask: number | null;
  ytm_close: number | null;
  coupon: number | null;     // % — from getInstrument cpn_rate; null until enriched
  freq: number | null;       // payments/year — from cpn_frequency_en; null until enriched
  maturity: string;          // YYYY-MM-DD; "" when AMX reports null
  last_trade: string | null; // true last-trade date; only backfill/enrichment can set it
  outstanding_amd: number | null; // from getInstrument outst_volume; null until enriched
  listing: string | null;    // AMX `list` / `list_class`
};

/** One compact history point per ISIN per day (short keys — the file grows daily). */
export type HistoryPoint = {
  d: string;                 // YYYY-MM-DD
  pb: number | null;         // price bid
  pa: number | null;         // price ask
  pc: number | null;         // price close (only on trade days)
  yb: number | null;         // yield bid
  ya: number | null;         // yield ask
  yc: number | null;         // yield close (only on trade days)
};

/** Extra fields that only the instrument endpoint carries. */
export type Enrichment = {
  coupon: number | null;
  freq: number | null;
  outstanding_amd: number | null;
  issuer: string | null;
  maturity: string | null;
  last_trade: string | null; // newest order_date with a real trade
};

/* ---------- raw AMX shapes (only the fields we read) ---------- */

type AmxQuoteBlock = { bid?: unknown; ask?: unknown; close?: unknown };
type AmxSnapRow = {
  isin?: string | null; ticker?: string | null;
  short_name_en?: string | null; short_name?: string | null;
  cur?: string | null; list?: string | null;
  maturity_date?: string | null; last_date?: string | null;
  price?: AmxQuoteBlock | null; yield?: AmxQuoteBlock | null;
};
type AmxSnapshot = { data?: AmxSnapRow[] };

type AmxMarketRow = {
  order_date?: string | null;
  trade_moment?: string | null;
  trades_number?: number | null;
  close_price?: unknown; close_yield?: unknown;
  best_bid_price?: unknown; best_ask_price?: unknown;
  best_bid_yield?: unknown; best_ask_yield?: unknown;
};
type AmxInstrument = {
  data?: {
    isin?: string | null; ticker?: string | null; issuer_name?: string | null;
    currency?: string | null; maturity_date?: string | null;
    cpn_rate?: unknown; cpn_frequency_en?: string | null;
    outst_volume?: unknown;
    market_data?: AmxMarketRow[];
  };
};

/* ---------- parsing helpers ---------- */

/** Parse AMX numerics: "94.0339", 7.25 → number; "-", "", "0.000000" caller-decides, null → null. */
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "" || v === "-") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const cleaned = v.replace(/%/g, "").replace(/\s/g, "").replace(/,/g, "");
    if (cleaned === "" || cleaned === "-") return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** AMX dates are "YYYY-MM-DD" (sometimes with a time suffix); validate and trim. */
function isoDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/** Map AMX coupon-frequency text to payments per year. */
function freqFromText(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = s.toLowerCase();
  if (t.includes("annual") && !t.includes("semi")) return 1;
  if (t.includes("semi")) return 2;
  if (t.includes("quarter")) return 4;
  if (t.includes("month")) return 12;
  return null;
}

/* ---------- snapshot mapping ---------- */

export function normalizeSnapshot(payload: unknown): Bond[] {
  const rows = (payload as AmxSnapshot)?.data;
  if (!Array.isArray(rows)) return [];

  const bonds: Bond[] = [];
  for (const r of rows) {
    const isin = (r.isin ?? "").trim();
    if (!isin) continue;

    const ccyRaw = (r.cur ?? "").toUpperCase();
    const ccy = (["AMD", "USD", "EUR"].includes(ccyRaw) ? ccyRaw : "AMD") as Bond["ccy"];

    bonds.push({
      isin,
      ticker: (r.ticker ?? isin).trim(),
      issuer: (r.short_name_en ?? r.short_name ?? "").trim(),
      ccy,
      price:     num(r.price?.bid),
      ask:       num(r.price?.ask),
      close:     num(r.price?.close),
      ytm:       num(r.yield?.bid),
      ytm_ask:   num(r.yield?.ask),
      ytm_close: num(r.yield?.close),
      coupon: null,
      freq: null,
      maturity:  isoDate(r.maturity_date) ?? "",
      last_trade: null,       // snapshot cannot know the true last-trade date
      outstanding_amd: null,
      listing: r.list ?? null,
    });
  }
  return bonds;
}

/** Build the compact daily history point for one bond (used by the snapshot job). */
export function toHistoryPoint(b: Bond, date: string): HistoryPoint {
  return { d: date, pb: b.price, pa: b.ask, pc: b.close, yb: b.ytm, ya: b.ytm_ask, yc: b.ytm_close };
}

/* ---------- instrument mapping (backfill / enrichment) ---------- */

/** A trade actually happened on a market_data row. */
function rowHasTrade(row: AmxMarketRow): boolean {
  return (row.trades_number ?? 0) > 0 || (row.trade_moment != null && row.trade_moment !== "");
}

/** Full per-day history from an instrument payload (one point per order_date). */
export function instrumentHistory(payload: unknown): HistoryPoint[] {
  const md = (payload as AmxInstrument)?.data?.market_data;
  if (!Array.isArray(md)) return [];

  const out: HistoryPoint[] = [];
  for (const row of md) {
    const d = isoDate(row.order_date);
    if (!d) continue;
    out.push({
      d,
      pb: num(row.best_bid_price),
      pa: num(row.best_ask_price),
      pc: num(row.close_price),   // null on no-trade days — that's correct
      yb: num(row.best_bid_yield),
      ya: num(row.best_ask_yield),
      yc: num(row.close_yield),
    });
  }
  out.sort((a, z) => a.d.localeCompare(z.d));
  return out;
}

/** Metadata + derived last-trade date from an instrument payload. */
export function instrumentEnrichment(payload: unknown): Enrichment {
  const d = (payload as AmxInstrument)?.data;
  if (!d) {
    return { coupon: null, freq: null, outstanding_amd: null, issuer: null, maturity: null, last_trade: null };
  }

  // Newest order_date that had a real trade → true "last trade" date.
  let lastTrade: string | null = null;
  for (const row of d.market_data ?? []) {
    if (rowHasTrade(row)) {
      const od = isoDate(row.order_date);
      if (od && (lastTrade === null || od > lastTrade)) lastTrade = od;
    }
  }

  return {
    coupon: num(d.cpn_rate),
    freq: freqFromText(d.cpn_frequency_en),
    outstanding_amd: num(d.outst_volume),
    issuer: (d.issuer_name ?? "").trim() || null,
    maturity: isoDate(d.maturity_date),
    last_trade: lastTrade,
  };
}

/* ---------- NMC detection (verified against the real payload) ---------- */

/** Issuer "National Mortgage Company RCO CJSC"; tickers NMCCBP/Q/R/S/T/U... */
export function isNmc(b: Bond): boolean {
  return /national mortgage company/i.test(b.issuer) || b.ticker.startsWith("NMCCB");
}
