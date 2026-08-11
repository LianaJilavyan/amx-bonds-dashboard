"use client";

// app/tabs/AnalyticsTab.tsx
// Placeholder for Increment 2. Kept in its own file so building the analytics
// content later doesn't require re-pasting Dashboard.tsx. Receives the FILTERED
// bond set so the calculations will honor the shared filter bar.
import type { UiBond, Meta } from "@/app/types";

export default function AnalyticsTab({ bonds }: { bonds: UiBond[]; meta: Meta }) {
  return (
    <div className="panel">
      <h2>
        <span>Analytics</span>
        <em>relative value · duration · convexity · spreads</em>
      </h2>
      <div className="empty">
        Rich/cheap vs the fitted curve, modified duration &amp; convexity, and
        benchmark spreads are being built in the next step.
      </div>
      <div className="method">
        This tab will rank each bond&apos;s residual to the OLS yield curve, show
        modified duration and convexity per bond, and — once a benchmark is chosen —
        spread to a reference yield by maturity bucket. Currently receiving{" "}
        <b>{bonds.length}</b> bonds from the filters above.
      </div>
    </div>
  );
}
