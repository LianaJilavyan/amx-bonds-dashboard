// app/layout.tsx
// Root layout: loads the two template fonts and the global stylesheet.
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Armenian Corporate Bonds Statistics — NMC",
  description:
    "Daily snapshot of AMX corporate bonds — bid/ask/close in yield and price, with per-bond history. Internal use at National Mortgage Company.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* Google Fonts, matching STYLE_TEMPLATE.html. Next hoists these <link>
            tags into <head> automatically. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Noto+Sans:wght@300;400;500;700;900&family=IBM+Plex+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
        {children}
      </body>
    </html>
  );
}
