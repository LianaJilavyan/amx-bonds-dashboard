// app/export/page.tsx
"use client";

// app/export/page.tsx
// Client-side report exporter at /export. Builds the SAME report as scripts/report.mjs
// entirely in the browser and downloads it as an HTML file — no workflow, no commit.
// - "As of" date: pulls each bond's last quote on-or-before that date from history.json.
// - Portfolios: read from THIS browser's localStorage (key amx.portfolios.v1).
// - Benchmark: ordinary least-squares curve fit PER CURRENCY on bid YTM (same as the app).
// history.json is imported dynamically (only on click) so it never bloats the main bundle.

import { useState } from "react";
import type { Bond, Enrichment, HistoryPoint } from "@/lib/normalize";
import { isNmc } from "@/lib/normalize";
import latest from "@/data/latest.json";
import enrichment from "@/data/enrichment.json";
import metaJson from "@/data/meta.json";

const latestData = latest as unknown as { date: string; fetchedAt: string; bonds: Bond[] };
const enrichmentData = enrichment as unknown as Record<string, Enrichment>;
const meta = metaJson as unknown as { latestDate: string; dates?: string[] };

/* localStorage shapes (mirror PortfoliosTab) */
type Holding = { isin: string; weight: number };
type Portfolio = { id: string; name: string; investedAmd: number; holdings: Holding[] };
const LS_KEY = "amx.portfolios.v1";

/* ---- formatting/math helpers (parity with report.mjs so output matches) ---- */
const DASH = "\u2014";
const RED = "#9a152c", NAVY = "#18164c";
const num = (v: unknown) =>
  v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v);
const fmt = (v: number | null | undefined, d = 2) =>
  v === null || v === undefined || Number.isNaN(v) ? DASH : Number(v).toFixed(d);
function fmtAmd(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return DASH;
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(a >= 1e10 ? 1 : 2) + "B";
  if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e8 ? 0 : 1) + "M";
  if (a >= 1e3) return (v / 1e3).toFixed(0) + "K";
  return String(v);
}
function fmtBps(v: number | null): string {
  if (v === null || Number.isNaN(v)) return DASH;
  const r = Math.round(v);
  return (r > 0 ? "+" : "") + r + " bp";
}
const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
function linreg(pts: { x: number; y: number }[]): { a: number; b: number } | null {
  const n = pts.length;
  if (n < 2) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of pts) { sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y; }
  const d = n * sxx - sx * sx;
  if (d === 0) return null;
  const b = (n * sxy - sx * sy) / d;
  return { a: (sy - b * sx) / n, b };
}
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function yearsTo(maturity: string, fromIso: string): number | null {
  if (!maturity) return null;
  const ms = Date.parse(maturity + "T00:00:00Z") - Date.parse(fromIso + "T00:00:00Z");
  if (Number.isNaN(ms)) return null;
  return ms / (365.25 * 86_400_000);
}

/* ---- as-of bond: static metadata + that date's quote from history ---- */
type AsOfBond = {
  isin: string; ticker: string; issuer: string; ccy: string;
  coupon: number | null; maturity: string; outstanding_amd: number | null;
  isNmc: boolean; years: number | null;
  ytm: number | null; ytm_close: number | null; price: number | null; close: number | null;
};

/** Last history point on or before asOf (history assumed ascending; sorted defensively). */
function quoteAsOf(hist: HistoryPoint[] | undefined, asOf: string): HistoryPoint | null {
  if (!hist || !hist.length) return null;
  const sorted = [...hist].sort((a, b) => a.d.localeCompare(b.d));
  let best: HistoryPoint | null = null;
  for (const p of sorted) { if (p.d <= asOf) best = p; else break; }
  return best;
}

function buildReportHtml(asOf: string, history: Record<string, HistoryPoint[]>, portfolios: Portfolio[]): { html: string; count: number } {
  // universe = currently-listed bonds (metadata merged from enrichment, like app/page.tsx)
  const bonds: AsOfBond[] = [];
  for (const b of latestData.bonds) {
    const e = enrichmentData[b.isin] || ({} as Enrichment);
    const maturity = b.maturity || e.maturity || "";
    const q = quoteAsOf(history[b.isin], asOf);
    if (!q) continue; // no quote on/before asOf → not shown for that date
    const merged: Bond = {
      ...b,
      coupon: e.coupon ?? b.coupon,
      outstanding_amd: e.outstanding_amd ?? b.outstanding_amd,
      maturity,
    };
    bonds.push({
      isin: b.isin, ticker: b.ticker, issuer: b.issuer, ccy: b.ccy,
      coupon: merged.coupon ?? null, maturity, outstanding_amd: merged.outstanding_amd ?? null,
      isNmc: isNmc(merged), years: yearsTo(maturity, asOf),
      ytm: num(q.yb), ytm_close: num(q.yc), price: num(q.pb), close: num(q.pc),
    });
  }
  const byIsin = new Map(bonds.map((b) => [b.isin.toUpperCase(), b]));

  // per-currency fitted curves on bid YTM
  const curves = new Map<string, { a: number; b: number } | null>();
  {
    const byCcy = new Map<string, AsOfBond[]>();
    for (const b of bonds) {
      if (b.years == null || b.years < 0 || b.ytm == null) continue;
      const arr = byCcy.get(b.ccy) || []; arr.push(b); byCcy.set(b.ccy, arr);
    }
    for (const [ccy, list] of byCcy)
      curves.set(ccy, list.length >= 3 ? linreg(list.map((b) => ({ x: b.years as number, y: b.ytm as number }))) : null);
  }
  const spreadBps = (b: AsOfBond): number | null => {
    const fit = curves.get(b.ccy);
    if (!fit || b.years == null || b.ytm == null) return null;
    return (b.ytm - (fit.a + fit.b * b.years)) * 100;
  };

  // market summary
  const amd = bonds.filter((b) => b.ccy === "AMD");
  const summary = {
    total: bonds.length,
    amd: amd.length,
    usd: bonds.filter((b) => b.ccy === "USD").length,
    nmc: bonds.filter((b) => b.isNmc).length,
    medAmdYtm: median(amd.map((b) => b.ytm).filter((v): v is number => v != null)),
  };

  // portfolios (light metrics + fitted-curve spread)
  const pfReports = portfolios.map((pf) => {
    const holdings = (pf.holdings || []).map((h) => {
      const b = byIsin.get(String(h.isin || "").trim().toUpperCase()) || null;
      const w = num(h.weight) || 0;
      const invested = num(pf.investedAmd) || 0;
      return { isin: h.isin, weight: w, bond: b, amt: invested > 0 ? (invested * w) / 100 : null, spread: b ? spreadBps(b) : null };
    });
    let wSum = 0, cWeighted = 0, incomeShare = 0, resolved = 0;
    for (const h of holdings) {
      const b = h.bond, w = (h.weight || 0) / 100;
      if (!b || b.coupon == null || w <= 0) continue;
      resolved += w; wSum += w; cWeighted += w * b.coupon; incomeShare += w * (b.coupon / 100);
    }
    const invested = num(pf.investedAmd) || 0;
    return {
      name: pf.name || "Portfolio", invested,
      income: invested > 0 ? invested * incomeShare : null,
      wCoupon: wSum > 0 ? cWeighted / wSum : null,
      coverage: resolved, holdings,
    };
  });

  // render (same template as the committed report)
  const th = (t: string, right?: boolean) => `<th style="text-align:${right ? "right" : "left"};padding:6px 8px;border-bottom:2px solid ${NAVY};font:600 12px 'IBM Plex Mono',monospace;color:${NAVY}">${esc(t)}</th>`;
  const td = (t: string, right?: boolean) => `<td style="text-align:${right ? "right" : "left"};padding:5px 8px;border-bottom:1px solid #eee;font:13px Arial,sans-serif">${t}</td>`;
  const card = (k: string, v: string, n?: string) => `
    <td style="padding:10px 14px;border:1px solid #eee;border-radius:8px;vertical-align:top">
      <div style="font:600 11px 'IBM Plex Mono',monospace;color:#777;text-transform:uppercase;letter-spacing:.04em">${esc(k)}</div>
      <div style="font:700 20px Arial,sans-serif;color:${NAVY};margin-top:3px">${v}</div>
      <div style="font:12px Arial,sans-serif;color:#999">${esc(n || "")}</div>
    </td>`;

  const generatedAt = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Yerevan", dateStyle: "medium", timeStyle: "short" }).format(new Date());

  const portfolioHtml = pfReports.length === 0
    ? `<p style="font:14px Arial;color:#777">No portfolios saved in this browser. Build one in the Portfolios tab first.</p>`
    : pfReports.map((p) => {
      const rows = p.holdings.map((h) => {
        const b = h.bond;
        const cheap = h.spread != null && h.spread >= 0;
        const spreadCell = h.spread == null ? DASH
          : `<span style="color:${cheap ? RED : NAVY};font-weight:600">${fmtBps(h.spread)}</span> ${cheap ? "cheap" : "rich"}`;
        return `<tr>
          ${td(esc(h.isin) + (b && b.isNmc ? ` <span style="background:${RED};color:#fff;border-radius:4px;padding:1px 5px;font-size:11px">NMC</span>` : ""))}
          ${td(b ? esc(b.issuer || DASH) : `<span style="color:${RED}">unknown ISIN</span>`)}
          ${td(fmt(h.weight, 1) + "%", true)}
          ${td(fmtAmd(h.amt), true)}
          ${td(b ? (b.coupon == null ? DASH : fmt(b.coupon) + "%") : DASH, true)}
          ${td(b ? (b.ytm == null ? DASH : fmt(b.ytm) + "%") : DASH, true)}
          ${td(b ? esc(b.maturity || DASH) : DASH)}
          ${td(spreadCell, true)}
        </tr>`;
      }).join("");
      return `
        <h3 style="font:700 16px Arial;color:${NAVY};margin:22px 0 6px">${esc(p.name)}</h3>
        <table style="border-collapse:separate;border-spacing:8px 0;margin-bottom:10px"><tr>
          ${card("Invested", p.invested > 0 ? fmtAmd(p.invested) : DASH, "AMD")}
          ${card("Exp. annual coupon", fmtAmd(p.income), "AMD / year")}
          ${card("Weighted coupon", p.wCoupon == null ? DASH : fmt(p.wCoupon) + "%", "by weight")}
          ${card("Weight coverage", fmt(p.coverage * 100, 0) + "%", "priced & resolved")}
        </tr></table>
        <table style="border-collapse:collapse;width:100%">
          <thead><tr>${th("ISIN")}${th("Issuer")}${th("Weight", true)}${th("Amount", true)}${th("Coupon", true)}${th("Bid YTM", true)}${th("Maturity")}${th("Spread vs curve", true)}</tr></thead>
          <tbody>${rows || `<tr>${td("No holdings")}</tr>`}</tbody>
        </table>`;
    }).join("");

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>NMC bond report — ${esc(asOf)}</title></head><body style="margin:0;background:#f6f6f8">
    <div style="max-width:820px;margin:0 auto;padding:24px;background:#fff;font-family:Arial,sans-serif;color:#222">
      <div style="border-bottom:4px solid ${RED};padding-bottom:12px">
        <div style="font:800 22px Arial;color:${NAVY}">Armenian Corporate Bonds — NMC report</div>
        <div style="font:14px Arial;color:#555">As of <b>${esc(asOf)}</b> · generated ${esc(generatedAt)} (Yerevan) · exported from the dashboard</div>
      </div>
      <h3 style="font:700 16px Arial;color:${NAVY};margin:20px 0 6px">Market summary</h3>
      <table style="border-collapse:separate;border-spacing:8px 0"><tr>
        ${card("Instruments", String(summary.total), "with a quote as of date")}
        ${card("Median AMD YTM", summary.medAmdYtm == null ? DASH : fmt(summary.medAmdYtm) + "%", `${summary.amd} AMD bonds`)}
        ${card("USD bonds", String(summary.usd), "")}
        ${card("NMC bonds", String(summary.nmc), "")}
      </tr></table>
      <h3 style="font:700 16px Arial;color:${NAVY};margin:24px 0 6px">Portfolios</h3>
      ${portfolioHtml}
      <p style="font:12px Arial;color:#999;margin-top:26px;border-top:1px solid #eee;padding-top:12px">
        “Spread vs curve” is each bond’s bid YTM minus an ordinary least-squares curve fit per currency;
        positive = cheap, negative = rich. Relative-value screen against peers, not a spread over a
        government/risk-free curve. Each bond uses its last quote on or before the chosen date. Prepared
        for internal use at National Mortgage Company. Not affiliated with or endorsed by AMX. Analysis
        only, not investment advice.
      </p>
    </div></body></html>`;

  return { html, count: bonds.length };
}

/* ============================================================================ */

export default function ExportPage() {
  const [asOf, setAsOf] = useState<string>(meta.latestDate);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function exportReport() {
    setBusy(true);
    setMsg(null);
    try {
      const history = (await import("@/data/history.json")).default as unknown as Record<string, HistoryPoint[]>;
      let portfolios: Portfolio[] = [];
      try {
        const raw = localStorage.getItem(LS_KEY);
        if (raw) { const p = JSON.parse(raw); if (Array.isArray(p)) portfolios = p; }
      } catch { /* none saved in this browser */ }

      const { html, count } = buildReportHtml(asOf, history, portfolios);
      if (count === 0) {
        setMsg({ ok: false, text: `No bond data on or before ${asOf}. Pick a later date.` });
        return;
      }
      const blob = new Blob([html], { type: "text/html;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `NMC-bond-report-${asOf}.html`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setMsg({ ok: true, text: `Exported ${count} bonds · ${portfolios.length} portfolio(s) as of ${asOf}.` });
    } catch (e) {
      setMsg({ ok: false, text: "Could not build the report: " + (e instanceof Error ? e.message : String(e)) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 640, margin: "40px auto", padding: "0 20px" }}>
      <div className="panel">
        <h2><span>Export report</span><em>as of a date</em></h2>
        <div className="body">
          <p className="note" style={{ marginBottom: 16 }}>
            Builds the NMC report (market summary + your saved portfolios + per-currency
            spreads) for the chosen date and downloads it as an HTML file. Portfolios come
            from this browser; market data comes from the app’s committed history.
          </p>
          <div className="controls" style={{ alignItems: "flex-end" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span className="note">As of date</span>
              <input
                type="date"
                value={asOf}
                max={meta.latestDate}
                onChange={(e) => setAsOf(e.target.value)}
                style={{ width: 180 }}
                aria-label="As of date"
              />
            </label>
            <button className="btn" onClick={exportReport} disabled={busy || !asOf}
                    style={{ borderColor: "var(--nmc-red)", color: "var(--nmc-red)" }}>
              {busy ? "Building…" : "Export HTML report"}
            </button>
          </div>
          {msg ? (
            <div className={msg.ok ? "note" : "miss"} style={{ marginTop: 12 }}>{msg.text}</div>
          ) : null}
          <div className="method" style={{ marginTop: 18 }}>
            Latest data date is <b>{esc(meta.latestDate)}</b>. Earlier dates use each bond’s
            last quote on or before that day, so a date before a bond first traded will omit it.
          </div>
        </div>
      </div>
    </div>
  );
}
