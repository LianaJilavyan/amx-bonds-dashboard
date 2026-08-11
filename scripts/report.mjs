// scripts/report.mjs
// Builds a portfolio + daily-market report "as of" a date and emails it via Resend.
// Triggered by .github/workflows/send-report.yml (Actions -> send-report -> Run workflow).
//
// Reads ONLY committed data — no network to AMX, no write to the repo:
//   data/portfolios.json           (array exported from the Portfolios tab)
//   data/snapshots/YYYY-MM-DD.json  (that day's market snapshot; falls back to the
//                                    nearest EARLIER day if the exact date is missing)
//   data/enrichment.json           (coupon/maturity/outstanding per ISIN, optional)
//   data/meta.json                 (latestDate, used when DATE="latest")
//
// Env (provided by the workflow):
//   DATE            "latest" | "YYYY-MM-DD" | "DD Mon YYYY"  (default "latest")
//   EMAIL          recipient address (required)
//   RESEND_API_KEY  Resend API key (GitHub Actions secret; if unset, the report is
//                   printed to the log instead of sent, so you can dry-run safely)
//   REPORT_FROM     sender address (optional; defaults to Resend's shared test sender)

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DATA = path.join(ROOT, "data");
const SNAP_DIR = path.join(DATA, "snapshots");
const TZ = "Asia/Yerevan";
const DASH = "\u2014";

/* ------------------------------- helpers -------------------------------- */
function readJson(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}
const num = (v) =>
  v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v);
const fmt = (v, d = 2) =>
  v === null || v === undefined || Number.isNaN(v) ? DASH : Number(v).toFixed(d);
function fmtAmd(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return DASH;
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(a >= 1e10 ? 1 : 2) + "B";
  if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e8 ? 0 : 1) + "M";
  if (a >= 1e3) return (v / 1e3).toFixed(0) + "K";
  return String(v);
}
function fmtBps(v) {
  if (v === null || Number.isNaN(v)) return DASH;
  const r = Math.round(v);
  return (r > 0 ? "+" : "") + r + " bp";
}
const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** OLS line y = a + b·x (same math as the dashboard's fitted curve). */
function linreg(pts) {
  const n = pts.length;
  if (n < 2) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of pts) { sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y; }
  const d = n * sxx - sx * sx;
  if (d === 0) return null;
  const b = (n * sxy - sx * sy) / d;
  return { a: (sy - b * sx) / n, b };
}
function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function yearsTo(maturity, fromIso) {
  if (!maturity) return null;
  const ms = Date.parse(maturity + "T00:00:00Z") - Date.parse(fromIso + "T00:00:00Z");
  if (Number.isNaN(ms)) return null;
  return ms / (365.25 * 86_400_000);
}
function isNmc(b) {
  return /national mortgage company/i.test(b.issuer || "") || String(b.ticker || "").startsWith("NMCCB");
}

const MONTHS = { jan:"01",feb:"02",mar:"03",apr:"04",may:"05",jun:"06",jul:"07",aug:"08",sep:"09",oct:"10",nov:"11",dec:"12" };
function parseDateInput(raw, latestDate) {
  const s = String(raw || "latest").trim();
  if (!s || s.toLowerCase() === "latest") return latestDate;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/); // "05 Aug 2026"
  if (m) {
    const mm = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mm) return `${m[3]}-${mm}-${m[1].padStart(2, "0")}`;
  }
  return s; // fall through; the snapshot lookup will fail loudly if unparseable
}

function snapshotDates() {
  try {
    return fs.readdirSync(SNAP_DIR)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map((f) => f.slice(0, 10))
      .sort();
  } catch { return []; }
}

/** Load snapshot bonds for a date, tolerating either { bonds: [...] } or a bare [...]. */
function loadSnapshot(isoDate) {
  const dates = snapshotDates();
  if (!dates.length) throw new Error(`No snapshots found in ${SNAP_DIR}`);
  let use = dates.includes(isoDate) ? isoDate : null;
  if (!use) {
    const earlier = dates.filter((d) => d <= isoDate);
    use = earlier.length ? earlier[earlier.length - 1] : null;
  }
  if (!use) throw new Error(`No snapshot on or before ${isoDate} (earliest is ${dates[0]}).`);
  const raw = readJson(path.join(SNAP_DIR, `${use}.json`));
  const bonds = Array.isArray(raw) ? raw : raw && Array.isArray(raw.bonds) ? raw.bonds : null;
  if (!bonds) throw new Error(`Snapshot ${use}.json has an unexpected shape (expected [] or { bonds: [] }).`);
  return { usedDate: use, bonds };
}

/* --------------------------------- main --------------------------------- */
const meta = readJson(path.join(DATA, "meta.json"), {}) || {};
const latestDate = meta.latestDate || snapshotDates().slice(-1)[0];
const wantedDate = parseDateInput(process.env.DATE, latestDate);
const { usedDate, bonds: rawBonds } = loadSnapshot(wantedDate);
const enrichment = readJson(path.join(DATA, "enrichment.json"), {}) || {};

const bonds = rawBonds.map((b) => {
  const e = enrichment[b.isin] || {};
  const maturity = b.maturity || e.maturity || "";
  return {
    ...b,
    coupon: b.coupon ?? e.coupon ?? null,
    outstanding_amd: b.outstanding_amd ?? e.outstanding_amd ?? null,
    maturity,
    years: yearsTo(maturity, usedDate),
    isNmc: isNmc(b),
  };
});
const byIsin = new Map(bonds.map((b) => [String(b.isin).toUpperCase(), b]));

// per-currency fitted curves on bid YTM (the benchmark you chose)
const curves = (() => {
  const byCcy = new Map();
  for (const b of bonds) {
    if (b.years == null || b.years < 0 || num(b.ytm) == null) continue;
    const arr = byCcy.get(b.ccy) || [];
    arr.push(b); byCcy.set(b.ccy, arr);
  }
  const out = new Map();
  for (const [ccy, list] of byCcy) {
    out.set(ccy, list.length >= 3 ? linreg(list.map((b) => ({ x: b.years, y: num(b.ytm) }))) : null);
  }
  return out;
})();
function spreadBps(b) {
  const fit = curves.get(b.ccy);
  if (!fit || b.years == null || num(b.ytm) == null) return null;
  return (num(b.ytm) - (fit.a + fit.b * b.years)) * 100;
}

// daily market summary
const amd = bonds.filter((b) => b.ccy === "AMD");
const summary = {
  total: bonds.length,
  amd: amd.length,
  usd: bonds.filter((b) => b.ccy === "USD").length,
  nmc: bonds.filter((b) => b.isNmc).length,
  medAmdYtm: median(amd.map((b) => num(b.ytm)).filter((v) => v != null)),
};

// portfolios (mirror the client's "light" metrics + add the fitted-curve spread)
const portfolios = readJson(path.join(DATA, "portfolios.json"), []) || [];
function computePortfolio(pf) {
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
    name: pf.name || "Portfolio",
    invested,
    income: invested > 0 ? invested * incomeShare : null,
    wCoupon: wSum > 0 ? cWeighted / wSum : null,
    coverage: resolved,
    totalWeight: holdings.reduce((s, h) => s + (h.weight || 0), 0),
    holdings,
  };
}
const pfReports = portfolios.map(computePortfolio);

/* ------------------------------- render --------------------------------- */
const RED = "#9a152c", NAVY = "#18164c";
const generatedAt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, dateStyle: "medium", timeStyle: "short" }).format(new Date());
const th = (t, right) => `<th style="text-align:${right ? "right" : "left"};padding:6px 8px;border-bottom:2px solid ${NAVY};font:600 12px 'IBM Plex Mono',monospace;color:${NAVY}">${esc(t)}</th>`;
const td = (t, right) => `<td style="text-align:${right ? "right" : "left"};padding:5px 8px;border-bottom:1px solid #eee;font:13px Arial,sans-serif">${t}</td>`;
const card = (k, v, n) => `
  <td style="padding:10px 14px;border:1px solid #eee;border-radius:8px;vertical-align:top">
    <div style="font:600 11px 'IBM Plex Mono',monospace;color:#777;text-transform:uppercase;letter-spacing:.04em">${esc(k)}</div>
    <div style="font:700 20px Arial,sans-serif;color:${NAVY};margin-top:3px">${v}</div>
    <div style="font:12px Arial,sans-serif;color:#999">${esc(n || "")}</div>
  </td>`;

const dateNote = usedDate === wantedDate ? "" :
  `<div style="font:13px Arial;color:${RED};margin-top:4px">No session on ${esc(wantedDate)} — showing the nearest earlier trading day, ${esc(usedDate)}.</div>`;

const portfolioHtml = pfReports.length === 0
  ? `<p style="font:14px Arial;color:#777">No portfolios committed yet. Use “Export portfolios.json” in the dashboard and commit the file into <code>/data</code>.</p>`
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
        ${td(b ? fmt(b.ytm) + "%" : DASH, true)}
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

const html = `<!doctype html><html><body style="margin:0;background:#f6f6f8">
  <div style="max-width:820px;margin:0 auto;padding:24px;background:#fff;font-family:Arial,sans-serif;color:#222">
    <div style="border-bottom:4px solid ${RED};padding-bottom:12px">
      <div style="font:800 22px Arial;color:${NAVY}">Armenian Corporate Bonds — NMC report</div>
      <div style="font:14px Arial;color:#555">As of <b>${esc(usedDate)}</b> · generated ${esc(generatedAt)} (Yerevan)</div>
      ${dateNote}
    </div>

    <h3 style="font:700 16px Arial;color:${NAVY};margin:20px 0 6px">Market summary</h3>
    <table style="border-collapse:separate;border-spacing:8px 0"><tr>
      ${card("Instruments", String(summary.total), "active bonds")}
      ${card("Median AMD YTM", summary.medAmdYtm == null ? DASH : fmt(summary.medAmdYtm) + "%", `${summary.amd} AMD bonds`)}
      ${card("USD bonds", String(summary.usd), "")}
      ${card("NMC bonds", String(summary.nmc), "")}
    </tr></table>

    <h3 style="font:700 16px Arial;color:${NAVY};margin:24px 0 6px">Portfolios</h3>
    ${portfolioHtml}

    <p style="font:12px Arial;color:#999;margin-top:26px;border-top:1px solid #eee;padding-top:12px">
      “Spread vs curve” is each bond’s bid YTM minus an ordinary least-squares curve fit per currency;
      positive = cheap, negative = rich. Relative-value screen against peers, not a spread over a
      government/risk-free curve. Prepared for internal use at National Mortgage Company. Not affiliated
      with or endorsed by AMX. Analysis only, not investment advice.
    </p>
  </div></body></html>`;

/* -------------------------------- send ---------------------------------- */
const EMAIL = (process.env.EMAIL || "").trim();
if (!EMAIL) throw new Error("EMAIL env var is required.");
const FROM = (process.env.REPORT_FROM || "NMC Bonds <onboarding@resend.dev>").trim();
const KEY = process.env.RESEND_API_KEY;
const subject = `NMC bond report — as of ${usedDate}`;

if (!KEY) {
  console.log("RESEND_API_KEY not set — DRY RUN. The report HTML follows; nothing was emailed.\n");
  console.log(html);
  process.exit(0);
}

const res = await fetch("https://api.resend.com/emails", {
  method: "POST",
  headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ from: FROM, to: [EMAIL], subject, html }),
});
if (!res.ok) {
  throw new Error(`Resend failed (${res.status}): ${await res.text()}`);
}
console.log(`Sent "${subject}" to ${EMAIL}.`);
