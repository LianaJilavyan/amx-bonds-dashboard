/**
 * lib/normalize.ts
 * Bond type + mapping from the raw AMX API response to our Bond record.
 *
 * ⚠️ FIELD NAMES BELOW ARE UNVERIFIED GUESSES (Phase 1).
 * The AMX endpoints are undocumented. Each field lists several candidate
 * key names; pick() tries them in order. In Phase 2, paste the real payload
 * into the chat and we will replace the guesses with exact names.
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
  coupon: number | null;
  freq: number | null;
  maturity: string;          // YYYY-MM-DD
  last_trade: string | null; // YYYY-MM-DD
  outstanding_amd: number | null;
  listing: string | null;
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

type Row = Record<string, unknown>;

/* ---------- small parsing helpers ---------- */

/** Parse "7.25", "7.25%", "1,234.5", 7.25 → number; anything else → null. */
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const cleaned = v.replace(/%/g, "").replace(/\s/g, "").replace(/,/g, "");
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Normalize a date-ish value ("2026-08-11", "11.08.2026", epoch ms) → "YYYY-MM-DD" or null. */
function isoDate(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") {
    const dt = new Date(v > 1e12 ? v : v * 1000); // ms vs seconds epoch
    return Number.isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10);
  }
  if (typeof v === "string") {
    const s = v.trim();
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);           // 2026-08-11...
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = s.match(/^(\d{2})[./](\d{2})[./](\d{4})/);          // 11.08.2026 / 11/08/2026
    if (m) return `${m[3]}-${m[2]}-${m[1]}`;
    const dt = new Date(s);
    return Number.isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10);
  }
  return null;
}

/** Return the first present, non-empty value among candidate keys (case-insensitive). */
function pick(row: Row, candidates: string[]): unknown {
  const lower = new Map(Object.keys(row).map((k) => [k.toLowerCase(), k]));
  for (const c of candidates) {
    const real = lower.get(c.toLowerCase());
    if (real !== undefined) {
      const v = row[real];
      if (v !== null && v !== undefined && v !== "") return v;
    }
  }
  return null;
}

/** The payload root might be an array, or wrapped ({ data: [...] } etc.). Find the row array. */
function findRows(payload: unknown): Row[] {
  if (Array.isArray(payload)) return payload as Row[];
  if (payload && typeof payload === "object") {
    const obj = payload as Row;
    for (const key of ["data", "rows", "result", "results", "bonds", "items", "instruments"]) {
      const v = obj[key];
      if (Array.isArray(v)) return v as Row[];
      // one level deeper, e.g. { data: { rows: [...] } }
      if (v && typeof v === "object") {
        for (const inner of Object.values(v as Row)) {
          if (Array.isArray(inner)) return inner as Row[];
        }
      }
    }
  }
  return [];
}

/* ---------- main mapping ---------- */

export function normalizeSnapshot(payload: unknown): Bond[] {
  const rows = findRows(payload);
  const bonds: Bond[] = [];

  for (const r of rows) {
    // ⚠️ UNVERIFIED candidate keys — to be finalized in Phase 2 against the real payload.
    const isin = String(pick(r, ["isin", "ISIN", "code", "symbol", "security_code"]) ?? "").trim();
    if (!isin) continue; // a bond without an identifier is unusable

    const ccyRaw = String(pick(r, ["currency", "ccy", "cur", "currency_code"]) ?? "").toUpperCase();
    const ccy = (["AMD", "USD", "EUR"].includes(ccyRaw) ? ccyRaw : "AMD") as Bond["ccy"];

    bonds.push({
      isin,
      ticker: String(pick(r, ["ticker", "symbol", "short_name", "code"]) ?? isin).trim(),
      issuer: String(pick(r, ["issuer", "issuer_name", "issuerName", "company", "organization", "emitent"]) ?? "").trim(),
      ccy,
      price:     num(pick(r, ["bid", "bid_price", "bidPrice", "price_bid", "best_bid_price"])),
      ask:       num(pick(r, ["ask", "ask_price", "askPrice", "offer", "best_ask_price"])),
      close:     num(pick(r, ["close", "close_price", "closePrice", "last_price", "closing_price"])),
      ytm:       num(pick(r, ["bid_yield", "yield_bid", "bidYield", "ytm_bid", "best_bid_yield"])),
      ytm_ask:   num(pick(r, ["ask_yield", "yield_ask", "askYield", "ytm_ask", "best_ask_yield"])),
      ytm_close: num(pick(r, ["close_yield", "yield_close", "closeYield", "ytm_close", "last_yield"])),
      coupon:    num(pick(r, ["coupon", "coupon_rate", "couponRate", "interest_rate", "rate"])),
      freq:      num(pick(r, ["coupon_frequency", "frequency", "freq", "coupon_period", "periodicity"])),
      maturity:  isoDate(pick(r, ["maturity", "maturity_date", "maturityDate", "redemption_date"])) ?? "",
      last_trade: isoDate(pick(r, ["last_trade", "last_trade_date", "lastTradeDate", "last_deal_date", "trade_date"])),
      outstanding_amd: num(pick(r, ["outstanding", "amount_outstanding", "outstanding_amount", "issue_volume", "volume"])),
      listing: (pick(r, ["listing", "list", "market", "board", "listing_category"]) as string | null) ?? null,
    });
  }
  return bonds;
}

/** Build the compact daily history point for one bond. */
export function toHistoryPoint(b: Bond, date: string): HistoryPoint {
  return { d: date, pb: b.price, pa: b.ask, pc: b.close, yb: b.ytm, ya: b.ytm_ask, yc: b.ytm_close };
}
