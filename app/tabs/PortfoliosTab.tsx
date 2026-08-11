// app/tabs/PortfoliosTab.tsx
"use client";

// app/tabs/PortfoliosTab.tsx
// Increment 3: client-side sign-in gate + portfolio builder (up to 3), saved to
// localStorage, with two ways to push into the repo:
//   - "Export portfolios.json" downloads the file to commit by hand (no token).
//   - "Save to GitHub" posts to /api/portfolios, which commits the file server-side
//     after checking a SEPARATE save passphrase held in server env vars. That
//     passphrase is NOT the Test/test01 sign-in and never ships in this bundle.
// Whatever lands in data/portfolios.json is picked up by the next report run.
//
// SECURITY NOTE: the Test/test01 login is a client-side gate only (password is in the
// shipped JS) — it keeps casual viewers out, not attackers. Real write protection for
// "Save to GitHub" is the server-side passphrase checked in app/api/portfolios/route.ts.

import { useEffect, useMemo, useState } from "react";
import type { UiBond, Meta } from "@/app/types";

/* ---- config ---- */
const LOGIN_USER = "Test";
const LOGIN_PASS = "test01";
const MAX_PORTFOLIOS = 3;
const LS_KEY = "amx.portfolios.v1";        // saved portfolios
const LS_AUTH = "amx.portfolios.auth.v1";  // "signed in" flag for this browser

/* ---- shapes ---- */
type Holding = { isin: string; weight: number }; // weight in % (target sum = 100)
type Portfolio = { id: string; name: string; investedAmd: number; holdings: Holding[] };

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

function newId(): string {
  return "pf_" + Math.random().toString(36).slice(2, 9);
}

function emptyPortfolio(n: number): Portfolio {
  return { id: newId(), name: `Portfolio ${n}`, investedAmd: 0, holdings: [] };
}

/* ============================================================================ */

export default function PortfoliosTab({ bonds }: { bonds: UiBond[]; meta: Meta }) {
  /* ---- auth (client-side gate) ---- */
  const [authed, setAuthed] = useState(false);
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [loginErr, setLoginErr] = useState("");

  useEffect(() => {
    try {
      if (localStorage.getItem(LS_AUTH) === "1") setAuthed(true);
    } catch { /* localStorage unavailable — stay signed out */ }
  }, []);

  function signIn() {
    if (user === LOGIN_USER && pass === LOGIN_PASS) {
      setAuthed(true);
      setLoginErr("");
      try { localStorage.setItem(LS_AUTH, "1"); } catch { /* ignore */ }
    } else {
      setLoginErr("Wrong username or password.");
    }
  }

  function signOut() {
    setAuthed(false);
    setUser(""); setPass("");
    try { localStorage.removeItem(LS_AUTH); } catch { /* ignore */ }
  }

  /* ---- portfolios (persisted to localStorage) ---- */
  const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Portfolio[];
        if (Array.isArray(parsed) && parsed.length) {
          setPortfolios(parsed);
          setActiveId(parsed[0].id);
        }
      }
    } catch { /* corrupt or unavailable — start empty */ }
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    try { localStorage.setItem(LS_KEY, JSON.stringify(portfolios)); } catch { /* ignore */ }
  }, [portfolios, loaded]);

  const active = useMemo(
    () => portfolios.find((p) => p.id === activeId) ?? null,
    [portfolios, activeId],
  );

  /* ---- portfolio mutations ---- */
  function addPortfolio() {
    if (portfolios.length >= MAX_PORTFOLIOS) return;
    const p = emptyPortfolio(portfolios.length + 1);
    setPortfolios((xs) => [...xs, p]);
    setActiveId(p.id);
  }

  function deletePortfolio(id: string) {
    setPortfolios((xs) => {
      const next = xs.filter((p) => p.id !== id);
      if (activeId === id) setActiveId(next[0]?.id ?? null);
      return next;
    });
  }

  function patchActive(patch: Partial<Portfolio>) {
    if (!active) return;
    setPortfolios((xs) => xs.map((p) => (p.id === active.id ? { ...p, ...patch } : p)));
  }

  function addHolding() {
    if (!active) return;
    patchActive({ holdings: [...active.holdings, { isin: "", weight: 0 }] });
  }

  function patchHolding(idx: number, patch: Partial<Holding>) {
    if (!active) return;
    const holdings = active.holdings.map((h, i) => (i === idx ? { ...h, ...patch } : h));
    patchActive({ holdings });
  }

  function removeHolding(idx: number) {
    if (!active) return;
    patchActive({ holdings: active.holdings.filter((_, i) => i !== idx) });
  }

  function normalizeWeights() {
    if (!active) return;
    const total = active.holdings.reduce((s, h) => s + (h.weight || 0), 0);
    if (total <= 0) return;
    const holdings = active.holdings.map((h) => ({
      ...h,
      weight: Math.round(((h.weight || 0) / total) * 1000) / 10, // 1 decimal place
    }));
    patchActive({ holdings });
  }

  /* ---- export: download portfolios.json to commit by hand (no token) ---- */
  function exportPortfolios() {
    const blob = new Blob([JSON.stringify(portfolios, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "portfolios.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  /* ---- save to GitHub via the server route (separate save passphrase) ---- */
  const [showSave, setShowSave] = useState(false);
  const [savePass, setSavePass] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function saveToGithub() {
    if (portfolios.length === 0 || !savePass) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const res = await fetch("/api/portfolios", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase: savePass, portfolios }),
      });
      const data = await res.json().catch(() => ({} as { error?: string }));
      if (!res.ok) {
        setSaveMsg({ ok: false, text: data?.error || `Save failed (${res.status}).` });
      } else {
        setSaveMsg({ ok: true, text: "Saved to GitHub — it will appear in the next report run." });
        setSavePass("");
        setShowSave(false);
      }
    } catch {
      setSaveMsg({ ok: false, text: "Network error while saving." });
    } finally {
      setSaving(false);
    }
  }

  /* ---- lookups + light metrics (no duration engine yet) ---- */
  const byIsin = useMemo(() => {
    const m = new Map<string, UiBond>();
    for (const b of bonds) m.set(b.isin, b);
    return m;
  }, [bonds]);

  const totalWeight = active ? active.holdings.reduce((s, h) => s + (h.weight || 0), 0) : 0;

  const light = useMemo(() => {
    if (!active || active.holdings.length === 0) {
      return { income: null as number | null, wCoupon: null as number | null, coverage: 0 };
    }
    let wSum = 0, cWeighted = 0, incomeShare = 0, resolved = 0;
    for (const h of active.holdings) {
      const b = byIsin.get(h.isin.trim().toUpperCase());
      const w = (h.weight || 0) / 100;
      if (!b || b.coupon == null || w <= 0) continue;
      resolved += w;
      wSum += w;
      cWeighted += w * b.coupon;
      incomeShare += w * (b.coupon / 100);
    }
    const income = active.investedAmd > 0 ? active.investedAmd * incomeShare : null;
    const wCoupon = wSum > 0 ? cWeighted / wSum : null;
    return { income, wCoupon, coverage: resolved };
  }, [active, byIsin]);

  /* ======================================================================== */
  /* Render: login gate                                                       */
  /* ======================================================================== */
  if (!authed) {
    return (
      <div className="panel">
        <h2><span>Portfolios</span><em>sign in</em></h2>
        <div className="body" style={{ maxWidth: 360 }}>
          <div className="warn" style={{ marginBottom: 16 }}>
            Sign-in here is a simple front-end gate, not real security — the
            password lives in the page code. Don&apos;t store anything sensitive.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <input
              type="text" placeholder="Username" value={user}
              onChange={(e) => setUser(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") signIn(); }}
              aria-label="Username"
            />
            <input
              type="password" placeholder="Password" value={pass}
              onChange={(e) => setPass(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") signIn(); }}
              aria-label="Password"
            />
            {loginErr ? <div className="miss" style={{ fontSize: 14 }}>{loginErr}</div> : null}
            <button className="btn" onClick={signIn} style={{ marginTop: 4 }}>Sign in</button>
          </div>
        </div>
      </div>
    );
  }

  /* ======================================================================== */
  /* Render: portfolio manager                                                */
  /* ======================================================================== */
  return (
    <div className="panel">
      <h2>
        <span>Portfolios</span>
        <em>
          {portfolios.length}/{MAX_PORTFOLIOS} saved{" "}
          <button className="btn" onClick={signOut}
                  style={{ marginLeft: 10, padding: "3px 8px" }}>Sign out</button>
        </em>
      </h2>

      {/* portfolio selector row + save/export */}
      <div className="controls">
        {portfolios.map((p) => (
          <button key={p.id} className="btn"
                  onClick={() => setActiveId(p.id)}
                  style={p.id === activeId
                    ? { borderColor: "var(--nmc-red)", color: "var(--nmc-red)" }
                    : undefined}>
            {p.name}
          </button>
        ))}
        {portfolios.length < MAX_PORTFOLIOS ? (
          <button className="btn" onClick={addPortfolio}>+ New portfolio</button>
        ) : (
          <span className="note">Maximum of {MAX_PORTFOLIOS} portfolios reached</span>
        )}
        <button
          className="btn"
          onClick={() => { setShowSave((s) => !s); setSaveMsg(null); }}
          disabled={portfolios.length === 0}
          title="Save portfolios to the repo (requires the save passphrase)"
          style={{ marginLeft: "auto", borderColor: "var(--nmc-red)", color: "var(--nmc-red)" }}
        >
          Save to GitHub
        </button>
        <button
          className="btn"
          onClick={exportPortfolios}
          disabled={portfolios.length === 0}
          title="Download portfolios.json to commit into /data by hand"
        >
          Export portfolios.json
        </button>
      </div>

      {/* save passphrase row (only when Save to GitHub is toggled) */}
      {showSave ? (
        <div className="controls" style={{ marginTop: 8 }}>
          <span className="note">Save passphrase:</span>
          <input
            type="password"
            value={savePass}
            placeholder="server save passphrase"
            style={{ width: 240 }}
            onChange={(e) => setSavePass(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") saveToGithub(); }}
            aria-label="Save passphrase"
          />
          <button className="btn" onClick={saveToGithub} disabled={saving || !savePass}>
            {saving ? "Saving…" : "Confirm save"}
          </button>
          <button className="btn" onClick={() => { setShowSave(false); setSavePass(""); }}>
            Cancel
          </button>
        </div>
      ) : null}
      {saveMsg ? (
        <div className={saveMsg.ok ? "note" : "miss"} style={{ marginTop: 6 }}>{saveMsg.text}</div>
      ) : null}

      {!active ? (
        <div className="empty">Create a portfolio to begin.</div>
      ) : (
        <div className="body">
          {/* name + invested amount */}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 16 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span className="note">Name</span>
              <input type="text" value={active.name} style={{ width: 220 }}
                     onChange={(e) => patchActive({ name: e.target.value })} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span className="note">Total invested (AMD)</span>
              <input type="number" min={0} step={1000} value={active.investedAmd || ""}
                     style={{ width: 200 }}
                     onChange={(e) => patchActive({ investedAmd: Number(e.target.value) || 0 })} />
            </label>
            <button className="btn" onClick={() => deletePortfolio(active.id)}
                    style={{ marginLeft: "auto" }}>Delete this portfolio</button>
          </div>

          {/* holdings editor */}
          <div style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <button className="btn" onClick={addHolding}>+ Add bond</button>
            <button className="btn" onClick={normalizeWeights}>Normalize to 100%</button>
            <span className="note" style={{ color: Math.abs(totalWeight - 100) < 0.05 ? "var(--dn)" : "var(--nmc-red)" }}>
              Total weight: {fmt(totalWeight, 1)}%
            </span>
          </div>

          {active.holdings.length === 0 ? (
            <div className="empty">No bonds yet — add one and pick an ISIN.</div>
          ) : (
            <div className="scroll" style={{ maxHeight: 520 }}>
              <table>
                <thead>
                  <tr>
                    <th className="l">ISIN</th>
                    <th className="l">Issuer</th>
                    <th>Weight %</th>
                    <th>Amount (AMD)</th>
                    <th>Coupon</th>
                    <th>Bid price</th>
                    <th>Bid YTM</th>
                    <th>Maturity</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {active.holdings.map((h, i) => {
                    const b = byIsin.get(h.isin.trim().toUpperCase());
                    const amt = active.investedAmd > 0 ? active.investedAmd * ((h.weight || 0) / 100) : null;
                    const unknown = h.isin.trim() !== "" && !b;
                    return (
                      <tr key={i}>
                        <td className="l">
                          <input type="text" list="pfIsinList" value={h.isin}
                                 placeholder="ISIN" style={{ width: 150 }}
                                 onChange={(e) => patchHolding(i, { isin: e.target.value })} />
                        </td>
                        <td className="l">
                          {b ? (
                            <>
                              {b.issuer || DASH}
                              {b.isNmc ? <span className="tag nmc" style={{ marginLeft: 6 }}>NMC</span> : null}
                            </>
                          ) : unknown ? (
                            <span className="miss">unknown ISIN</span>
                          ) : DASH}
                        </td>
                        <td>
                          <input type="number" min={0} step={0.1} value={h.weight || ""}
                                 style={{ width: 80, textAlign: "right" }}
                                 onChange={(e) => patchHolding(i, { weight: Number(e.target.value) || 0 })} />
                        </td>
                        <td>{fmtAmd(amt)}</td>
                        <td>{b ? (b.coupon == null ? DASH : fmt(b.coupon) + "%") : DASH}</td>
                        <td>{b ? fmt(b.price) : DASH}</td>
                        <td>{b ? (b.ytm == null ? DASH : fmt(b.ytm) + "%") : DASH}</td>
                        <td>{b ? (b.maturity || DASH) : DASH}</td>
                        <td>
                          <button className="del" title="Remove" onClick={() => removeHolding(i)}>×</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* shared datalist of all ISINs */}
          <datalist id="pfIsinList">
            {bonds.map((b) => <option key={b.isin} value={b.isin}>{b.issuer}</option>)}
          </datalist>

          {/* light metrics available now */}
          <div className="cards" style={{ marginTop: 20 }}>
            <div className="card">
              <div className="k">Invested</div>
              <div className="v">{active.investedAmd > 0 ? fmtAmd(active.investedAmd) : DASH}</div>
              <div className="n">AMD</div>
            </div>
            <div className="card">
              <div className="k">Exp. annual coupon</div>
              <div className="v">{fmtAmd(light.income)}</div>
              <div className="n">AMD / year</div>
            </div>
            <div className="card">
              <div className="k">Weighted coupon</div>
              <div className="v">{light.wCoupon == null ? DASH : fmt(light.wCoupon) + "%"}</div>
              <div className="n">by weight</div>
            </div>
            <div className="card">
              <div className="k">Weight coverage</div>
              <div className="v">{fmt(light.coverage * 100, 0)}%</div>
              <div className="n">priced &amp; resolved</div>
            </div>
          </div>

          <div className="method" style={{ marginTop: 16 }}>
            <b>Coming next (Increment 2 → 3):</b> market-value-weighted YTM, portfolio
            modified duration &amp; convexity, DV01, scenario P&amp;L (±25/±50/±100 bps),
            issuer concentration and a duration ladder — the full set from the analytics
            spec. This view already shows invested amount, expected annual coupon income,
            and weighted coupon. Metrics count only holdings that resolve to a priced bond;
            &ldquo;weight coverage&rdquo; tells you how much of the portfolio that is.
          </div>
        </div>
      )}
    </div>
  );
}
