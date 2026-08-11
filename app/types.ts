// app/types.ts
// UI-facing bond record: the pipeline's Bond plus a few fields the page derives
// once on the server (in app/page.tsx) so the client component stays simple.
import type { Bond, IssuerType } from "@/lib/normalize";

export type UiBond = Bond & {
  isNmc: boolean;             // NMC-issued (drives red highlight / "NMC only" filter)
  issuerType: IssuerType;     // Bank / Credit organization / Other (issuer-type filter)
  daysSinceTrade: number | null; // latestDate - last_trade, in calendar days
  years: number | null;      // years to maturity from latestDate (null if no maturity)
};

export type Meta = {
  latestDate: string;
  dates: string[];
  bondCount: number;
  lastRunStatus: string;
  lastError?: string | null;
  lastRunAt?: string;
};
