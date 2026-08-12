// app/Dashboard.tsx
"use client";

// app/Dashboard.tsx
// The interactive dashboard, reproducing STYLE_TEMPLATE.html. Pure React + inline
// SVG (no chart library, per ARCHITECTURE.md). Increment 1: the single page is now
// split into tabs (Overview · Yield curve · Screener · Analytics · Portfolios).
// The masthead + freshness header stay global above the tab bar. Filter state lives
// here and is shared by the Yield-curve and Screener tabs via <Filters/>.

import { useEffect, useMemo, useRef, useState } from "react";
import type { HistoryPoint } from "@/lib/normalize";
import type { UiBond, Meta } from "@/app/types";
import AnalyticsTab from "@/app/tabs/AnalyticsTab";
import PortfoliosTab from "@/app/tabs/PortfoliosTab";

const STALE_DAYS = 20; // matches ARCHITECTURE.md / reference dashboard

/* ---------------- quotation modes (mirror the AMX "Quotation" dropdown) ------- */
type ModeKey = "ytm" | "ytm_close" | "price" | "close" | "coupon";
type HistKey = keyof Pick<HistoryPoint, "pb" | "pa" | "pc" | "yb" | "ya" | "yc">;

type ModeDef = { label: string; axis: string; get: (b: UiBond) => number | null; hk: HistKey; noHist?: boolean };

const MODES: Record<ModeKey, ModeDef> = {
  ytm:       { label: "AMX bid yield",  axis: "Bid YTM (%)",   get: (b) => b.ytm,       hk: "yb" },
  ytm_close: { label: "AMX close yield", axis: "Close YTM (%)", get: (b) => b.ytm_close, hk: "yc" },
  price:     { label: "AMX bid price",  axis: "Bid price",      get: (b) => b.price,     hk: "pb" },
  close:     { label: "AMX close price", axis: "Close price",   get: (b) => b.close,     hk: "pc" },
  coupon:    { label: "Coupon",         axis: "Coupon (%)",     get: (b) => b.coupon,    hk: "yb", noHist: true },
};

/* ---------------- small formatting / math helpers ---------------------------- */
const DASH = "\u2014";
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

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** ~`count`+1 evenly spaced tick values across [min,max]. */
function ticks(min: number, max: number, count = 5): number[] {
  if (min === max) return [min];
  const out: number[] = [];
  for (let i = 0; i <= count; i++) out.push(min + ((max - min) * i) / count);
  return out;
}

/** Ordinary least-squares line y = a + b·x. */
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

/* ---------------- tabs ---------------- */
type TabKey = "overview" | "curve" | "screener" | "analytics" | "portfolios";
const TABS: { k: TabKey; label: string }[] = [
  { k: "overview",   label: "Overview" },
  { k: "curve",      label: "Yield curve" },
  { k: "screener",   label: "Screener" },
  { k: "analytics",  label: "Analytics" },
  { k: "portfolios", label: "Portfolios" },
];

/* ============================================================================ */

export default function Dashboard({ bonds, meta }: { bonds: UiBond[]; meta: Meta }) {
  const latestDate = meta.latestDate;

  /* ---- tab ---- */
  const [tab, setTab] = useState<TabKey>("overview");

  /* ---- filter + view state (ids mirror STYLE_TEMPLATE.html) ---- */
  const [qIsin, setQIsin] = useState("");
  const [qIssuer, setQIssuer] = useState("");
  const [mode, setMode] = useState<ModeKey>("ytm");
  const [ccy, setCcy] = useState("AMD");          // default currency = AMD
  const [mat, setMat] = useState("");
  const [issuerTypeF, setIssuerTypeF] = useState(""); // "" = all issuer types
  const [onlyNmc, setOnlyNmc] = useState(false);
  const [hideStale, setHideStale] = useState(false);

  const [sortKey, setSortKey] = useState<string>("ytm");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [selected, setSelected] = useState<string | null>(null);

  const M = MODES[mode];

  const isStale = (b: UiBond) => b.daysSinceTrade === null || b.daysSinceTrade > STALE_DAYS;

  const ccyOptions = useMemo(
    () => Array.from(new Set(bonds.map((b) => b.ccy))).sort(),
    [bonds],
  );
  const issuerList = useMemo(
    () => Array.from(new Set(bonds.map((b) => b.issuer).filter(Boolean))).sort(),
    [bonds],
  );

  /* ---- filtering (drives scatter, table and analytics) ---- */
  const filtered = useMemo(() => {
    const qi = qIsin.trim().toUpperCase();
    const qs = qIssuer.trim().toLowerCase();
    return bonds.filter((b) => {
      if (qi && !b.isin.toUpperCase().includes(qi)) return false;
      if (qs && !b.issuer.toLowerCase().includes(qs)) return false;
      if (issuerTypeF && b.issuerType !== issuerTypeF) return false;
      if (ccy && b.ccy !== ccy) return false;
      if (onlyNmc && !b.isNmc) return false;
      if (hideStale && isStale(b)) return false;
      if (mat) {
        const y = b.years;
        if (y === null) return false;
        if (mat === "0-1" && !(y < 1)) return false;
        if (mat === "1-3" && !(y >= 1 && y < 3)) return false;
        if (mat === "3-5" && !(y >= 3 && y < 5)) return false;
        if (mat === "5-99" && !(y >= 5)) return false;
      }
      return true;
    });
  }, [bonds, qIsin, qIssuer, issuerTypeF, ccy, mat, onlyNmc, hideStale]);

  /* ---- headline stats (whole universe) ---- */
  const stats = useMemo(() => {
    const amdYtm = bonds.filter((b) => b.ccy === "AMD" && b.ytm != null).map((b) => b.ytm as number);
    const tradedWeek = bonds.filter((b) => b.daysSinceTrade != null && b.daysSinceTrade <= 7).length;
    return {
      total: bonds.length,
      medianAmdYtm: median(amdYtm),
      nmc: bonds.filter((b) => b.isNmc).length,
      tradedWeek,
    };
  }, [bonds]);

  /* ---- sorted rows for the table ---- */
  const sorted = useMemo(() => {
    const get = (b: UiBond): string | number | null => {
      switch (sortKey) {
        case "isin": return b.isin;
        case "issuer": return b.issuer;
        case "ccy": return b.ccy;
        case "coupon": return b.coupon;
        case "price": return b.price;
        case "ytm": return b.ytm;
        case "close": return b.close;
        case "ytm_close": return b.ytm_close;
        case "maturity": return b.maturity || null;
        case "days_since_trade": return b.daysSinceTrade;
        default: return b.isin;
      }
    };
    const dir = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const va = get(a), vb = get(b);
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      if (typeof va === "string" || typeof vb === "string") {
        return String(va).localeCompare(String(vb)) * dir;
      }
      return (va - vb) * dir;
    });
  }, [filtered, sortKey, sortDir]);

  function onSort(key: string) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(["isin", "issuer", "ccy", "maturity"].includes(key) ? "asc" : "desc");
    }
  }

  /* ---- selected instrument + its history (fetched on demand) ---- */
  const selBond = useMemo(() => bonds.find((b) => b.isin === selected) ?? null, [bonds, selected]);
  const [history, setHistory] = useState<HistoryPoint[] | null>(null);
  const [histLoading, setHistLoading] = useState(false);
  const histCache = useRef<Map<string, HistoryPoint[]>>(new Map());

  useEffect(() => {
    if (!selected) { setHistory(null); return; }
    const cached = histCache.current.get(selected);
    if (cached) { setHistory(cached); return; }
    let alive = true;
    setHistLoading(true);
    fetch(`/api/history/${encodeURIComponent(selected)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: HistoryPoint[]) => {
        if (!alive) return;
        histCache.current.set(selected, data);
        setHistory(data);
      })
      .catch(() => { if (alive) setHistory([]); })
      .finally(() => { if (alive) setHistLoading(false); });
    return () => { alive = false; };
  }, [selected]);

  const fresh = meta.lastRunStatus === "ok";

  /* ---- shared filter bar props ---- */
  const filterProps = {
    bonds, issuerList, ccyOptions,
    qIsin, setQIsin, qIssuer, setQIssuer,
    issuerTypeF, setIssuerTypeF,
    ccy, setCcy, mat, setMat,
    onlyNmc, setOnlyNmc, hideStale, setHideStale,
    mode, setMode,
  };

  return (
    <>
      {/* ============ MASTHEAD ============ */}
      <div className="mast"><div className="mast-in">
        <div className="mast-title">
          <h1>Armenian Corporate Bonds Statistics <em>| secondary market</em></h1>
          <div className="strap">AMX data <b>|</b> NMC bonds</div>
        </div>
        <div className="logos">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="nmc" src="/nmc-logo.png" alt="National Mortgage Company" />
          <span className="sep" />
          <a href="https://amx.am/en/market_data/corporate_bonds" target="_blank" rel="noopener"
             aria-label="Data source: Armenia Securities Exchange">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="amx" src="/amx-logo.svg" alt="AMX Armenia Stock Exchange" />
          </a>
        </div>
      </div></div>

      <div className="wrap">
        {/* ============ HEADER (global) ============ */}
        <header>
          <div className="sub" id="stamp">
            {`MARKET DATE ${latestDate} \u00b7 ${bonds.length} INSTRUMENTS`}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span className={`badge${fresh ? "" : " warn"}`} id="fresh">
              <span className="pip" />
              <span id="freshText">
                {fresh ? "Data current" : `Last successful update ${latestDate}`}
              </span>
            </span>
            
              <a href="/export" style={{ display: "inline-block", padding: "5px 12px", borderRadius: "6px", border: "1.5px solid var(--nmc-red)", color: "var(--nmc-red)", fontWeight: 600, fontSize: "13px", textDecoration: "none", whiteSpace: "nowrap" }}>
              Export report &#8599;
            </a>
          </div>
          <p className="lede" id="lede">
            Daily snapshot of <b>AMX corporate bonds</b> — bid/ask/close in both{" "}
            <b>yield</b> and <b>price</b> terms, with per-bond history.
          </p>
        </header>

        {/* ============ TAB BAR ============ */}
        <nav className="tabs" role="tablist" aria-label="Dashboard sections">
          {TABS.map((t) => (
            <button key={t.k} role="tab" className="tab" id={`tab-${t.k}`}
                    aria-selected={tab === t.k} aria-controls={`panel-${t.k}`}
                    onClick={() => setTab(t.k)}>
              {t.label}
            </button>
          ))}
        </nav>

        {/* ============ OVERVIEW ============ */}
        {tab === "overview" && (
          <div className="tabpanel" id="panel-overview" role="tabpanel" aria-labelledby="tab-overview">
            <div className="cards" id="cards">
              <div className="card">
                <div className="k">Instruments</div>
                <div className="v">{stats.total}</div>
                <div className="n">active</div>
              </div>
              <div className="card">
                <div className="k">Median bid YTM</div>
                <div className="v">{stats.medianAmdYtm === null ? DASH : fmt(stats.medianAmdYtm) + "%"}</div>
                <div className="n">AMD bonds</div>
              </div>
              <div className="card nmc">
                <div className="k">NMC bonds</div>
                <div className="v">{stats.nmc}</div>
              </div>
              <div className="card">
                <div className="k">Traded this week</div>
                <div className="v">{stats.tradedWeek}</div>
                <div className="n">of {stats.total}</div>
              </div>
            </div>
          </div>
        )}

        {/* ============ YIELD CURVE ============ */}
        {tab === "curve" && (
          <div className="tabpanel" id="panel-curve" role="tabpanel" aria-labelledby="tab-curve">
            <div className="pair">
              {/* ---- scatter panel ---- */}
              <div className="panel">
                <h2>
                  <span>Yield to maturity against maturity</span>
                  <em id="fitNote">{scatterNote(filtered, M)}</em>
                </h2>
                <Filters {...filterProps} showMode />
                <div className="legend">
                  <span><i style={{ background: "var(--nmc-red)" }} />NMC</span>
                  <span><i style={{ background: "none", border: "1.5px solid var(--nmc-navy)" }} />Other issuers</span>
                  <span><i style={{ background: "none", border: "1.5px dashed var(--nmc-navy)" }} />Fitted curve</span>
                  <span>Dot size = amount outstanding</span>
                </div>
                <div className="body">
                  <Scatter bonds={filtered} mode={M} selected={selected} onSelect={setSelected} />
                </div>
                <div className="method">
                  Each dot is one bond: <b>x</b> = years to maturity, <b>y</b> = <b>{M.axis}</b>,
                  dot size ∝ amount outstanding. The dashed line is an ordinary least-squares
                  fit across the plotted bonds — a rough market curve, not a model.
                  Bonds without a maturity or without a <code>{M.axis}</code> value are omitted
                  from the chart but remain in the Screener.
                </div>
              </div>

              {/* ---- detail panel ---- */}
              <div className="panel">
                <h2>
                  <span>Selected instrument</span>
                  <em id="selName">{selBond ? selBond.ticker : ""}</em>
                </h2>
                {!selBond ? (
                  <div id="detail">
                    <div className="empty">Click any bond in the chart to see its history</div>
                  </div>
                ) : (
                  <div id="detail">
                    <div className="facts">
                      <div><span>Coupon</span>{selBond.coupon == null ? DASH : fmt(selBond.coupon) + "%"}</div>
                      <div><span>Maturity</span>{selBond.maturity || DASH}</div>
                      <div><span>Currency</span>{selBond.ccy}</div>
                      <div><span>Outstanding</span>{fmtAmd(selBond.outstanding_amd)}{selBond.outstanding_amd == null ? "" : " " + selBond.ccy}</div>
                      <div>
                        <span>Last trade</span>
                        {selBond.last_trade
                          ? `${selBond.last_trade} (${selBond.daysSinceTrade}d)`
                          : DASH}
                        {isStale(selBond) ? <span className="tag" style={{ marginLeft: 6 }}>stale</span> : null}
                      </div>
                    </div>
                    <Sparkline
                      history={history}
                      loading={histLoading}
                      mode={M}
                      ccyOrPct={mode === "price" || mode === "close" ? "" : "%"}
                    />
                    <div className="method">
                      Sparkline: <b>{M.axis}</b> over time
                      {M.noHist ? " (coupon has no daily series, so bid yield is shown)" : ""}.
                      Source: <code>/api/history/{selBond.isin}</code>.
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ============ SCREENER ============ */}
        {tab === "screener" && (
          <div className="tabpanel" id="panel-screener" role="tabpanel" aria-labelledby="tab-screener">
            <div className="panel">
              <h2>
                <span>Investment list</span>
                <em id="count">{filtered.length} shown</em>
              </h2>
              <Filters {...filterProps} />
              <div className="scroll" id="tblWrap">
                <table id="tbl">
                  <thead><tr>{TABLE_COLS.map((c) => (
                    <th key={c.k} className={c.l ? "l" : undefined} data-k={c.k}
                        onClick={() => onSort(c.k)}
                        aria-sort={sortKey === c.k ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
                      {c.label}{sortKey === c.k ? (sortDir === "asc" ? " \u25B2" : " \u25BC") : ""}
                    </th>
                  ))}</tr></thead>
                  <tbody>
                    {sorted.map((b) => {
                      const stale = isStale(b);
                      const rowCls = [b.isNmc ? "isnmc" : "", selected === b.isin ? "sel" : "", stale ? "stale" : ""]
                        .filter(Boolean).join(" ");
                      const priceCls = b.price == null ? "" : b.price < 100 ? "cheap" : b.price > 100 ? "rich" : "";
                      return (
                        <tr key={b.isin} className={rowCls || undefined} tabIndex={0}
                            onClick={() => setSelected(b.isin)}
                            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(b.isin); } }}>
                          <td className="l">{b.isin}</td>
                          <td className="l">
                            {b.issuer || DASH}
                            {b.isNmc ? <span className="tag nmc" style={{ marginLeft: 6 }}>NMC</span> : null}
                          </td>
                          <td>{b.ccy}</td>
                          <td>{fmt(b.coupon)}</td>
                          <td className={priceCls}>{fmt(b.price)}</td>
                          <td>{fmt(b.ytm)}</td>
                          <td>{fmt(b.close)}</td>
                          <td>{fmt(b.ytm_close)}</td>
                          <td>{b.maturity || DASH}</td>
                          <td className={b.daysSinceTrade == null ? "miss" : undefined}
                              title={b.last_trade ?? "no trade on record"}>
                            {b.daysSinceTrade == null ? DASH : `${b.daysSinceTrade}d`}
                          </td>
                        </tr>
                      );
                    })}
                    {sorted.length === 0 ? (
                      <tr><td className="l" colSpan={TABLE_COLS.length}>
                        <div className="empty">No instruments match the current filters</div>
                      </td></tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* ============ ANALYTICS ============ */}
        {tab === "analytics" && (
          <div className="tabpanel" id="panel-analytics" role="tabpanel" aria-labelledby="tab-analytics">
            <AnalyticsTab bonds={filtered} meta={meta} />
          </div>
        )}

        {/* ============ PORTFOLIOS ============ */}
        {tab === "portfolios" && (
          <div className="tabpanel" id="panel-portfolios" role="tabpanel" aria-labelledby="tab-portfolios">
            <PortfoliosTab bonds={bonds} meta={meta} />
          </div>
        )}

        <footer id="foot">
          Market data from{" "}
          <a href="https://amx.am/en/market_data/corporate_bonds" target="_blank" rel="noopener"
             style={{ color: "var(--nmc-red)" }}>Armenia Securities Exchange</a>; yields as AMX publishes them.<br />
          Prepared for internal use at National Mortgage Company. Not affiliated with or endorsed by AMX.
          Analysis only, not investment advice.
        </footer>
      </div>
    </>
  );
}

/* ============================================================================ */
/* Shared filter bar — rendered on the Yield-curve and Screener tabs.           */
/* `showMode` adds the #fMode quotation select (only the scatter uses it).      */
/* ============================================================================ */
function Filters({
  bonds, issuerList, ccyOptions,
  qIsin, setQIsin, qIssuer, setQIssuer,
  issuerTypeF, setIssuerTypeF,
  ccy, setCcy, mat, setMat,
  onlyNmc, setOnlyNmc, hideStale, setHideStale,
  mode, setMode, showMode = false,
}: {
  bonds: UiBond[]; issuerList: string[]; ccyOptions: string[];
  qIsin: string; setQIsin: (v: string) => void;
  qIssuer: string; setQIssuer: (v: string) => void;
  issuerTypeF: string; setIssuerTypeF: (v: string) => void;
  ccy: string; setCcy: (v: string) => void;
  mat: string; setMat: (v: string) => void;
  onlyNmc: boolean; setOnlyNmc: (v: boolean) => void;
  hideStale: boolean; setHideStale: (v: boolean) => void;
  mode: ModeKey; setMode: (v: ModeKey) => void;
  showMode?: boolean;
}) {
  return (
    <div className="controls">
      <input id="qIsin" type="search" placeholder="ISIN" style={{ width: 130 }}
             list="isinList" value={qIsin} onChange={(e) => setQIsin(e.target.value)} />
      <datalist id="isinList">
        {bonds.map((b) => <option key={b.isin} value={b.isin} />)}
      </datalist>
      <input id="qIssuer" type="search" placeholder="Issuer (type to search)" style={{ width: 190 }}
             list="issuerList" value={qIssuer} onChange={(e) => setQIssuer(e.target.value)} />
      <datalist id="issuerList">
        {issuerList.map((n) => <option key={n} value={n} />)}
      </datalist>
      {/* NEW: issuer-type grouping */}
      <select id="fType" title="Issuer type" value={issuerTypeF}
              onChange={(e) => setIssuerTypeF(e.target.value)}>
        <option value="">All issuer types</option>
        <option value="Bank">Bank</option>
        <option value="Credit organization">Credit organization</option>
        <option value="Other">Other</option>
      </select>
      {showMode ? (
        <select id="fMode" title="What both charts plot"
                value={mode} onChange={(e) => setMode(e.target.value as ModeKey)}>
          <option value="ytm">AMX bid yield</option>
          <option value="ytm_close">AMX close yield</option>
          <option value="price">AMX bid price</option>
          <option value="close">AMX close price</option>
          <option value="coupon">Coupon</option>
        </select>
      ) : null}
      <select id="fCcy" title="Currency" value={ccy} onChange={(e) => setCcy(e.target.value)}>
        <option value="">All currencies</option>
        {ccyOptions.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      <select id="fMat" value={mat} onChange={(e) => setMat(e.target.value)}>
        <option value="">All maturities</option>
        <option value="0-1">Under 1 year</option>
        <option value="1-3">1 to 3 years</option>
        <option value="3-5">3 to 5 years</option>
        <option value="5-99">Over 5 years</option>
      </select>
      <label className="toggle">
        <input type="checkbox" id="onlyNmc" checked={onlyNmc}
               onChange={(e) => setOnlyNmc(e.target.checked)} />NMC only
      </label>
      <label className="toggle" id="staleLbl"
             title="Hides bonds whose last trade is more than 20 days old.">
        <input type="checkbox" id="hideStale" checked={hideStale}
               onChange={(e) => setHideStale(e.target.checked)} />
        Hide stale <span className="qm">?</span>
      </label>
    </div>
  );
}

/* ---------------- table column config ---------------- */
const TABLE_COLS: { k: string; label: string; l?: boolean }[] = [
  { k: "isin", label: "ISIN", l: true },
  { k: "issuer", label: "Issuer", l: true },
  { k: "ccy", label: "Ccy" },
  { k: "coupon", label: "Coupon" },
  { k: "price", label: "Bid price" },
  { k: "ytm", label: "Bid YTM" },
  { k: "close", label: "Close price" },
  { k: "ytm_close", label: "Close YTM" },
  { k: "maturity", label: "Maturity" },
  { k: "days_since_trade", label: "Last trade" },
];

/** Short "N plotted · linear fit" note for the scatter panel heading. */
function scatterNote(bonds: UiBond[], M: (typeof MODES)[ModeKey]): string {
  const n = bonds.filter((b) => b.years !== null && b.years >= 0 && M.get(b) !== null).length;
  return `${n} plotted${n >= 3 ? " \u00b7 linear fit" : ""}`;
}

/* ============================================================================ */
/* Scatter: years-to-maturity (x) vs the selected quotation metric (y).         */
/* ============================================================================ */
function Scatter({
  bonds, mode, selected, onSelect,
}: {
  bonds: UiBond[];
  mode: (typeof MODES)[ModeKey];
  selected: string | null;
  onSelect: (isin: string) => void;
}) {
  const W = 700, H = 430, m = { l: 58, r: 18, t: 14, b: 48 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;

  const pts = useMemo(() => {
    return bonds
      .map((b) => ({ b, x: b.years, y: mode.get(b) }))
      .filter((p): p is { b: UiBond; x: number; y: number } =>
        p.x !== null && p.x >= 0 && p.y !== null);
  }, [bonds, mode]);

  if (pts.length === 0) {
    return (
      <svg id="scatter" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="No bonds to plot">
        <text x={W / 2} y={H / 2} textAnchor="middle" className="ax">
          No bonds match these filters
        </text>
      </svg>
    );
  }

  const xmax = Math.max(1, Math.ceil(Math.max(...pts.map((p) => p.x))));
  const ys = pts.map((p) => p.y);
  let ymin = Math.min(...ys), ymax = Math.max(...ys);
  if (ymin === ymax) { ymin -= 1; ymax += 1; }
  const padY = (ymax - ymin) * 0.08;
  ymin -= padY; ymax += padY;

  const sx = (x: number) => m.l + (x / xmax) * iw;
  const sy = (y: number) => m.t + ih - ((y - ymin) / (ymax - ymin)) * ih;

  const maxOut = Math.max(1, ...pts.map((p) => p.b.outstanding_amd ?? 0));
  const r = (o: number | null) =>
    o == null || o <= 0 ? 3.5 : 3.5 + Math.sqrt(o / maxOut) * 12.5;

  const fit = linreg(pts.map((p) => ({ x: p.x, y: p.y })));

  const xticks = ticks(0, xmax, Math.min(xmax, 6));
  const yticks = ticks(ymin, ymax, 5);

  const others = pts.filter((p) => !p.b.isNmc && p.b.isin !== selected);
  const nmc = pts.filter((p) => p.b.isNmc && p.b.isin !== selected);
  const sel = pts.find((p) => p.b.isin === selected) ?? null;

  return (
    <svg id="scatter" viewBox={`0 0 ${W} ${H}`} role="img"
         aria-label={`${mode.axis} against years to maturity`}>
      <defs>
        <clipPath id="plotClip">
          <rect x={m.l} y={m.t} width={iw} height={ih} />
        </clipPath>
      </defs>

      <g className="grid">
        {yticks.map((t, i) => (
          <line key={i} x1={m.l} x2={m.l + iw} y1={sy(t)} y2={sy(t)} />
        ))}
      </g>
      <g className="ax">
        {yticks.map((t, i) => (
          <text key={i} x={m.l - 8} y={sy(t) + 4} textAnchor="end">{t.toFixed(1)}</text>
        ))}
        {xticks.map((t, i) => (
          <text key={i} x={sx(t)} y={m.t + ih + 20} textAnchor="middle">{t.toFixed(0)}</text>
        ))}
      </g>

      <text className="axlab" x={m.l + iw / 2} y={H - 8} textAnchor="middle">Years to maturity</text>
      <text className="axlab" transform={`translate(14 ${m.t + ih / 2}) rotate(-90)`} textAnchor="middle">
        {mode.axis}
      </text>

      {fit ? (
        <path className="fit" clipPath="url(#plotClip)"
              d={`M ${sx(0)} ${sy(fit.a)} L ${sx(xmax)} ${sy(fit.a + fit.b * xmax)}`} />
      ) : null}

      {others.map((p) => (
        <circle key={p.b.isin} cx={sx(p.x)} cy={sy(p.y)} r={r(p.b.outstanding_amd)}
                fill="none" stroke="var(--nmc-navy)" strokeWidth={1.4} opacity={0.8}
                style={{ cursor: "pointer" }} onClick={() => onSelect(p.b.isin)}>
          <title>{`${p.b.ticker} · ${p.b.issuer}\n${mode.axis}: ${fmt(p.y)} · ${p.x.toFixed(2)}y`}</title>
        </circle>
      ))}
      {nmc.map((p) => (
        <circle key={p.b.isin} cx={sx(p.x)} cy={sy(p.y)} r={r(p.b.outstanding_amd)}
                fill="var(--nmc-red)" opacity={0.9}
                style={{ cursor: "pointer" }} onClick={() => onSelect(p.b.isin)}>
          <title>{`${p.b.ticker} · ${p.b.issuer}\n${mode.axis}: ${fmt(p.y)} · ${p.x.toFixed(2)}y`}</title>
        </circle>
      ))}
      {sel ? (
        <g style={{ cursor: "pointer" }} onClick={() => onSelect(sel.b.isin)}>
          <circle cx={sx(sel.x)} cy={sy(sel.y)} r={r(sel.b.outstanding_amd)}
                  fill={sel.b.isNmc ? "var(--nmc-red)" : "none"}
                  stroke="var(--nmc-red)" strokeWidth={2} opacity={0.95} />
          <circle cx={sx(sel.x)} cy={sy(sel.y)} r={r(sel.b.outstanding_amd) + 4}
                  fill="none" stroke="var(--nmc-red)" strokeWidth={1} opacity={0.6} />
          <title>{`${sel.b.ticker} · ${sel.b.issuer}\n${mode.axis}: ${fmt(sel.y)} · ${sel.x.toFixed(2)}y`}</title>
        </g>
      ) : null}
    </svg>
  );
}

/* ============================================================================ */
/* Sparkline: one instrument's chosen metric over time.                         */
/* ============================================================================ */
function Sparkline({
  history, loading, mode, ccyOrPct,
}: {
  history: HistoryPoint[] | null;
  loading: boolean;
  mode: (typeof MODES)[ModeKey];
  ccyOrPct: string;
}) {
  const W = 700, H = 210, m = { l: 48, r: 14, t: 12, b: 26 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;

  const series = useMemo(() => {
    if (!history) return [];
    return history
      .map((p) => ({ t: Date.parse(p.d + "T00:00:00Z"), d: p.d, v: p[mode.hk] as number | null }))
      .filter((p): p is { t: number; d: string; v: number } => p.v !== null && !Number.isNaN(p.t))
      .sort((a, b) => a.t - b.t);
  }, [history, mode.hk]);

  if (loading) {
    return <div className="empty">Loading history…</div>;
  }
  if (series.length < 2) {
    return <div className="empty">Not enough history to draw a line for this metric</div>;
  }

  const tmin = series[0].t, tmax = series[series.length - 1].t;
  const vs = series.map((p) => p.v);
  let vmin = Math.min(...vs), vmax = Math.max(...vs);
  if (vmin === vmax) { vmin -= 1; vmax += 1; }
  const pad = (vmax - vmin) * 0.1; vmin -= pad; vmax += pad;

  const sx = (t: number) => (tmax === tmin ? m.l : m.l + ((t - tmin) / (tmax - tmin)) * iw);
  const sy = (v: number) => m.t + ih - ((v - vmin) / (vmax - vmin)) * ih;

  const d = series.map((p, i) => `${i === 0 ? "M" : "L"} ${sx(p.t).toFixed(1)} ${sy(p.v).toFixed(1)}`).join(" ");
  const last = series[series.length - 1];
  const yt = ticks(vmin, vmax, 4);

  return (
    <div className="body" style={{ paddingTop: 0 }}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${mode.axis} history`}>
        <g className="grid">
          {yt.map((t, i) => <line key={i} x1={m.l} x2={m.l + iw} y1={sy(t)} y2={sy(t)} />)}
        </g>
        <g className="ax">
          {yt.map((t, i) => (
            <text key={i} x={m.l - 6} y={sy(t) + 4} textAnchor="end">{t.toFixed(1)}</text>
          ))}
          <text x={m.l} y={H - 8} textAnchor="start">{series[0].d}</text>
          <text x={m.l + iw} y={H - 8} textAnchor="end">{last.d}</text>
        </g>
        <path d={d} fill="none" stroke="var(--nmc-navy)" strokeWidth={1.6} />
        <circle cx={sx(last.t)} cy={sy(last.v)} r={3.5} fill="var(--nmc-red)" />
        <text x={sx(last.t)} y={sy(last.v) - 8} textAnchor="end" className="ax"
              style={{ fill: "var(--nmc-red)" }}>
          {fmt(last.v)}{ccyOrPct}
        </text>
      </svg>
    </div>
  );
}
