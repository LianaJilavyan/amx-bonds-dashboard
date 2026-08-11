// app/tabs/AnalyticsTab.tsx
"use client";

// app/tabs/AnalyticsTab.tsx
// Increment 2 (relative value): rich/cheap vs a FITTED CORPORATE CURVE.
// The benchmark is an ordinary least-squares fit of YTM against years-to-maturity,
// computed SEPARATELY PER CURRENCY — AMD and USD sit on very different curves, so a
// single blended line would flag every AMD bond cheap and every USD bond rich.
// Spread = bond YTM - curve YTM at that bond's maturity, in basis points:
//   positive -> the bond yields MORE than the curve -> "cheap"
//   negative -> the bond yields LESS than the curve  -> "rich"
// This mirrors the dashed fit line on the Yield-curve tab, so the number here and
// that chart always agree. It is a relative-value measure (spread to peers), NOT a
// credit spread over a government/risk-free curve — the AMX corporate feed has no
// government bonds to build one from.
//
// Receives the FILTERED bond set from Dashboard, so the shared filter bar
// (currency, issuer, maturity bucket, NMC-only, hide-stale) narrows what is fit and
// ranked. A local Bid/Close toggle chooses which published YTM to use; spread-to-
// curve is a yield concept, so this tab intentionally omits the price modes of #fMode.

import { useMemo, useState } from "react";
import type { UiBond, Meta } from "@/app/types";

/* ---- local formatting helpers (kept per-file, as elsewhere in the app) ---- */
const DASH = "\u2014";
const fmt = (v: number | null | undefined, d = 2) =>
  v === null || v === undefined || Number.isNaN(v) ? DASH : Number(v).toFixed(d);

/** Signed basis points, with an explicit + so cheap/rich reads at a glance. */
function fmtBps(v: number | null): string {
  if (v === null || Number.isNaN(v)) return DASH;
  const r = Math.round(v);
  return (r > 0 ? "+" : "") + r + " bp";
}

/** Ordinary least-squares line y = a + b·x (same math as the scatter's fit). */
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

/* ---- yield basis: which published YTM feeds the fit and the spread ---- */
type Basis = "bid" | "close";
const BASIS: Record<Basis, { label: string; get: (b: UiBond) => number | null }> = {
  bid:   { label: "Bid YTM",   get: (b) => b.ytm },
  close: { label: "Close YTM", get: (b) => b.ytm_close },
};

type Row = { b: UiBond; years: number; ytm: number; fitted: number; spread: number };
type Curve = { a: number; b: number; n: number; rmse: number };

/** Minimum bonds needed to trust a per-currency fit. */
const MIN_FIT = 3;

export default function AnalyticsTab({ bonds }: { bonds: UiBond[]; meta: Meta }) {
  const [basis, setBasis] = useState<Basis>("bid");
  const B = BASIS[basis];

  /* Group the (already-filtered) bonds by currency, fit one curve each, then
     compute every bond's spread to its own currency's curve. */
  const { rows, curves } = useMemo(() => {
    // usable = has a forward maturity and a YTM on the chosen basis
    const usable = bonds.filter(
      (b) => b.years !== null && b.years >= 0 && B.get(b) !== null,
    );

    const byCcy = new Map<string, UiBond[]>();
    for (const b of usable) {
      const arr = byCcy.get(b.ccy) ?? [];
      arr.push(b);
      byCcy.set(b.ccy, arr);
    }

    const curves = new Map<string, Curve | null>();
    const rows: Row[] = [];

    for (const [ccy, list] of byCcy) {
      const fit =
        list.length >= MIN_FIT
          ? linreg(list.map((b) => ({ x: b.years as number, y: B.get(b) as number })))
          : null;

      if (!fit) {
        curves.set(ccy, null); // too few bonds after filtering — skip this currency
        continue;
      }

      // root-mean-square residual, converted %→bp, as a fit-quality read
      let ss = 0;
      for (const b of list) {
        const y = B.get(b) as number;
        const f = fit.a + fit.b * (b.years as number);
        ss += (y - f) * (y - f);
      }
      const rmse = Math.sqrt(ss / list.length) * 100;
      curves.set(ccy, { a: fit.a, b: fit.b, n: list.length, rmse });

      for (const b of list) {
        const years = b.years as number;
        const ytm = B.get(b) as number;
        const fitted = fit.a + fit.b * years;
        rows.push({ b, years, ytm, fitted, spread: (ytm - fitted) * 100 });
      }
    }

    rows.sort((x, y) => y.spread - x.spread); // cheapest (most positive) first
    return { rows, curves };
  }, [bonds, basis]);

  const evaluated = rows.length;
  const cheapest = rows[0] ?? null;
  const richest = rows.length ? rows[rows.length - 1] : null;
  const absMax = rows.reduce((m, r) => Math.max(m, Math.abs(r.spread)), 0) || 1;

  const skipped = Array.from(curves.entries())
    .filter(([, v]) => v === null)
    .map(([ccy]) => ccy);

  return (
    <div className="panel">
      <h2>
        <span>Analytics — rich / cheap vs the fitted curve</span>
        <em>{evaluated} bond{evaluated === 1 ? "" : "s"} scored</em>
      </h2>

      {/* local yield-basis toggle (spread is a yield concept, so no price modes) */}
      <div className="controls" style={{ marginBottom: 12 }}>
        <span className="note">Yield basis:</span>
        {(Object.keys(BASIS) as Basis[]).map((k) => (
          <button
            key={k}
            className="btn"
            onClick={() => setBasis(k)}
            style={basis === k ? { borderColor: "var(--nmc-red)", color: "var(--nmc-red)" } : undefined}
          >
            {BASIS[k].label}
          </button>
        ))}
      </div>

      {evaluated === 0 ? (
        <div className="empty">
          Not enough bonds with a maturity and a {B.label} value to fit a curve. Widen the
          filters above — e.g. clear the currency or maturity filter.
        </div>
      ) : (
        <div className="body">
          {/* fit summary: one card per currency curve, plus the two extremes */}
          <div className="cards">
            {Array.from(curves.entries()).map(([ccy, v]) =>
              v ? (
                <div className="card" key={ccy}>
                  <div className="k">{ccy} curve</div>
                  <div className="v">
                    {fmt(v.a, 2)}% <span style={{ fontSize: 14, fontWeight: 400 }}>@ 0y</span>
                  </div>
                  <div className="n">
                    slope {fmt(v.b * 100, 0)} bp/yr · {v.n} bonds · fit ±{fmt(v.rmse, 0)} bp
                  </div>
                </div>
              ) : null,
            )}
            <div className="card">
              <div className="k">Cheapest</div>
              <div className="v" style={{ color: "var(--nmc-red)" }}>
                {cheapest ? fmtBps(cheapest.spread) : DASH}
              </div>
              <div className="n">{cheapest ? cheapest.b.ticker : DASH}</div>
            </div>
            <div className="card">
              <div className="k">Richest</div>
              <div className="v" style={{ color: "var(--nmc-navy)" }}>
                {richest ? fmtBps(richest.spread) : DASH}
              </div>
              <div className="n">{richest ? richest.b.ticker : DASH}</div>
            </div>
          </div>

          {skipped.length ? (
            <div className="note" style={{ margin: "10px 0" }}>
              Not enough bonds to fit a {skipped.join(", ")} curve (need at least {MIN_FIT});
              those bonds are omitted from the ranking.
            </div>
          ) : null}

          {/* ranked table: cheapest at the top */}
          <div className="scroll" style={{ maxHeight: 560, marginTop: 8 }}>
            <table>
              <thead>
                <tr>
                  <th className="l">ISIN</th>
                  <th className="l">Issuer</th>
                  <th>Ccy</th>
                  <th>Years</th>
                  <th>{B.label}</th>
                  <th>Curve</th>
                  <th>Spread</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const cheap = r.spread >= 0;
                  return (
                    <tr key={r.b.isin}>
                      <td className="l">{r.b.isin}</td>
                      <td className="l">
                        {r.b.issuer || DASH}
                        {r.b.isNmc ? <span className="tag nmc" style={{ marginLeft: 6 }}>NMC</span> : null}
                      </td>
                      <td>{r.b.ccy}</td>
                      <td>{fmt(r.years, 2)}</td>
                      <td>{fmt(r.ytm)}%</td>
                      <td>{fmt(r.fitted)}%</td>
                      <td style={{ fontWeight: 600, color: cheap ? "var(--nmc-red)" : "var(--nmc-navy)" }}>
                        {fmtBps(r.spread)}
                      </td>
                      <td style={{ width: 84 }}>
                        <span
                          className="tag"
                          style={{
                            background: cheap ? "var(--nmc-red)" : "var(--nmc-navy)",
                            color: "#fff",
                            opacity: 0.35 + 0.65 * (Math.abs(r.spread) / absMax),
                          }}
                        >
                          {cheap ? "cheap" : "rich"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="method" style={{ marginTop: 16 }}>
            The benchmark is an ordinary least-squares line fit to <b>{B.label}</b> against
            years to maturity, computed <b>separately per currency</b>. A bond&apos;s{" "}
            <b>spread</b> is its yield minus the curve&apos;s yield at the same maturity, in
            basis points: <b>positive = cheap</b> (yields more than peers),{" "}
            <b>negative = rich</b>. &ldquo;fit ±N bp&rdquo; is the root-mean-square residual —
            how tightly bonds hug the line, i.e. how much to trust the ranking. This is a
            relative-value screen against peers, not a spread over a government/risk-free curve
            (the AMX corporate feed has none). The fit uses the same method as the dashed line
            on the Yield-curve tab, so the two agree. Bonds without a maturity or without a{" "}
            {B.label} value are omitted.
          </div>
        </div>
      )}
    </div>
  );
}
