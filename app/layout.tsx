// app/layout.tsx — minimal root layout; the real design arrives in Phase 3.
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "AMX Corporate Bonds — NMC",
  description: "Armenian corporate bonds statistics (internal, NMC)",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif" }}>{children}</body>
    </html>
  );
}
