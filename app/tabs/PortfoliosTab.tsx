"use client";

// app/tabs/PortfoliosTab.tsx
// Placeholder for Increment 3 (sign-in gate + portfolio builder + analytics,
// saved to localStorage). Receives the full universe so the builder can pick any ISIN.
import type { UiBond, Meta } from "@/app/types";

export default function PortfoliosTab({ bonds }: { bonds: UiBond[]; meta: Meta }) {
  return (
    <div className="panel">
      <h2>
        <span>Portfolios</span>
        <em>sign in to build up to 3</em>
      </h2>
      <div className="empty">
        Sign-in, the portfolio builder (pick ISINs + weights, enter an invested
        amount) and the full analytics set are being built in the next step.
      </div>
      <div className="method">
        You&apos;ll be able to select from the <b>{bonds.length}</b> bonds in the
        universe, assign weights, and see weighted YTM, portfolio duration, DV01,
        scenario P&amp;L, issuer concentration and a duration ladder.
      </div>
    </div>
  );
}
