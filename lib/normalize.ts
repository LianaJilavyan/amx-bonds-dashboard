/**
 * lib/normalize.ts
 * Bond type + mapping from the raw AMX API response to our Bond record.
 *
 * ✅ FINALIZED (Phase 2) against a real payload from
 * GET https://amx.am/api/getMarketData/corporate_bonds captured 2026-08-11.
 *
 * Real shape:
 *   { "data": [ {
 *       id, isin_id, isin, ticker, trades,
 *       maturity_date: "YYYY-MM-DD" | null,        // null seen (e.g. UNIBBU)
 *       short_name, short_name_en, short_name_ru, short_id,
 *       list: "BBOND" | ...,                       // listing board
 *       last_date: "YYYY-MM-DD",                   // ⚠️ may be quote date, not last TRADE
 *       cur: "AMD" | "USD" | ...,
 *       price: { change, change_percent, bid, ask, avg, open, close, high, low },
 *       yield: { same keys },                      // all values are STRINGS; "-" = missing
 *       dls, vol, val,                             // deals / volume / value for the day
 *       rates: [ ... ]                             // FX-converted quotes; not used
 *   } ] }
 *
 * NOT present in the snapshot: coupon, frequency, amount outstanding.
 * Those come from getInstrument/{ISIN} and are filled in by the backfill /
 * enrichment step; until then they are null.
 *
 * Shared by scripts/fetch.mjs (run via `tsx`) and, later, the frontend.
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
  coupon: number | null;     // null until enriched from getInstrument
  freq: number | null;       // null until enriched from getInstrument
  maturity: string;          // YYYY-MM-DD; "" when AMX reports null (e.g. undated/perpetual)
  last_trade: string | null; // from `last_date` — verify meaning against the AMX site
  outstanding_amd: number | null; // null until enriched from getInstrument
  listing: string | null;    // AMX `list`, e.g. "BBOND"
};

/** One compact history point per ISIN per day (short keys — file grows daily). */
export type HistoryPoint = {
  d: string;                 // YYYY-MM-DD
  pb: number | null;         // price bid
  pa: number | null;         // price ask
  pc: number | null;         // price close
  yb: number | null;         // yield bid
  ya: number | null;         // yield ask
  yc: number | null;         // yield close
};

/* ---------- raw AMX shapes (only the fields we read) ---------- */

type AmxQuoteBlock = {
  bid?: string | number | null;
  ask?: string | number | null;
  close?: string | number | null;
};

type AmxRow = {
  isin?: string | null;
  ticker?: string | null;
  short_name_en?: string | null;
  short_name?: string | null;
  cur?: string | null;
  list?: string | null;
  maturity_date?: string | null;
  last_date?: string | null;
  price?: AmxQuoteBlock | null;
  yield?: AmxQuoteBlock | null;
};

type AmxSnapshot = { data?: AmxRow[] };

/* ---------- parsing helpers ---------- */

/** Parse AMX numerics: "94.0339", "17.2999", 7.25 → number; "-", "", null → null. */
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

/** AMX dates are already "YYYY-MM-DD"; validate and trim any time suffix. */
function isoDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/* ---------- main mapping ---------- */

export function normalizeSnapshot(payload: unknown): Bond[] {
  const rows = (payload as AmxSnapshot)?.data;
  if (!Array.isArray(rows)) return [];

  const bonds: Bond[] = [];
  for (const r of rows) {
    const isin = (r.isin ?? "").trim();
    if (!isin) continue; // a bond without an identifier is unusable

    const ccyRaw = (r.cur ?? "").toUpperCase();
    // AMX quotes corporate bonds in AMD/USD/EUR; default defensively to AMD.
    const ccy = (["AMD", "USD", "EUR"].includes(ccyRaw) ? ccyRaw : "AMD") as Bond["ccy"];

    bonds.push({
      isin,
      ticker: (r.ticker ?? isin).trim(),
      // English name preferred; Armenian short_name as fallback so issuer is never empty.
      issuer: (r.short_name_en ?? r.short_name ?? "").trim(),
      ccy,
      price:     num(r.price?.bid),
      ask:       num(r.price?.ask),
      close:     num(r.price?.close),
      ytm:       num(r.yield?.bid),
      ytm_ask:   num(r.yield?.ask),
      ytm_close: num(r.yield?.close),
      coupon: null,           // not in snapshot — enriched from getInstrument later
      freq: null,             // not in snapshot — enriched from getInstrument later
      maturity:  isoDate(r.maturity_date) ?? "",
      last_trade: isoDate(r.last_date),
      outstanding_amd: null,  // not in snapshot — enriched from getInstrument later
      listing: r.list ?? null,
    });
  }
  return bonds;
}

/** Build the compact daily history point for one bond. */
export function toHistoryPoint(b: Bond, date: string): HistoryPoint {
  return { d: date, pb: b.price, pa: b.ask, pc: b.close, yb: b.ytm, ya: b.ytm_ask, yc: b.ytm_close };
}

/** NMC detection, verified against the real payload: issuer
 *  "National Mortgage Company RCO CJSC", tickers NMCCBP/Q/R/S/T/U... */
export function isNmc(b: Bond): boolean {
  return /national mortgage company/i.test(b.issuer) || b.ticker.startsWith("NMCCB");
}
