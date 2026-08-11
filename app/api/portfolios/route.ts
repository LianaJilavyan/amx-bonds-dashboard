// app/api/portfolios/route.ts
// Server-side save endpoint. Commits data/portfolios.json to the repo via the GitHub
// Contents API. The GitHub token and the save passphrase live ONLY in server env vars
// (no NEXT_PUBLIC_ prefix) so neither is ever shipped to the browser. The client sends
// the passphrase in the POST body; we compare it server-side, timing-safe.
//
// Env vars (set in Vercel, Production + Preview):
//   GH_REPO_TOKEN   fine-grained PAT, Contents: Read and write, THIS repo only
//   GH_REPO         "owner/name", e.g. "LianaJilavyan/amx-bonds-dashboard"
//   GH_BRANCH       optional, defaults to "main"
//   SAVE_PASSPHRASE the shared save passphrase (pick a long random string)

import crypto from "node:crypto";

export const runtime = "nodejs";       // need node crypto + Buffer, not edge
export const dynamic = "force-dynamic"; // never cache this route

const MAX_BODY = 200_000;   // ~200 KB guard against oversized payloads
const MAX_PORTFOLIOS = 50;

function jsonError(status: number, error: string) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Constant-time string compare (avoids leaking the passphrase via timing). */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

type Holding = { isin: string; weight: number };
type Portfolio = { id: string; name: string; investedAmd: number; holdings: Holding[] };

/** Shape-check the payload before we commit it, so we never write garbage. */
function isPortfolioArray(x: unknown): x is Portfolio[] {
  if (!Array.isArray(x) || x.length > MAX_PORTFOLIOS) return false;
  for (const p of x) {
    if (typeof p !== "object" || p === null) return false;
    const q = p as Record<string, unknown>;
    if (typeof q.id !== "string" || typeof q.name !== "string") return false;
    if (typeof q.investedAmd !== "number" || !Number.isFinite(q.investedAmd)) return false;
    if (!Array.isArray(q.holdings)) return false;
    for (const h of q.holdings) {
      if (typeof h !== "object" || h === null) return false;
      const r = h as Record<string, unknown>;
      if (typeof r.isin !== "string") return false;
      if (typeof r.weight !== "number" || !Number.isFinite(r.weight)) return false;
    }
  }
  return true;
}

export async function POST(req: Request) {
  const token = process.env.GH_REPO_TOKEN;
  const repo = process.env.GH_REPO;             // "owner/name"
  const branch = process.env.GH_BRANCH || "main";
  const passphrase = process.env.SAVE_PASSPHRASE;

  if (!token || !repo || !passphrase) {
    return jsonError(500, "Saving isn't configured on the server (missing GH_REPO_TOKEN, GH_REPO, or SAVE_PASSPHRASE).");
  }

  const raw = await req.text();
  if (raw.length > MAX_BODY) return jsonError(413, "Payload too large.");

  let body: unknown;
  try { body = JSON.parse(raw); } catch { return jsonError(400, "Invalid JSON."); }

  const { passphrase: given, portfolios } =
    (body ?? {}) as { passphrase?: unknown; portfolios?: unknown };

  if (typeof given !== "string" || !safeEqual(given, passphrase)) {
    return jsonError(401, "Wrong save passphrase.");
  }
  if (!isPortfolioArray(portfolios)) {
    return jsonError(400, "Portfolios payload has an unexpected shape.");
  }

  const filePath = "data/portfolios.json";
  const apiBase = `https://api.github.com/repos/${repo}/contents/${filePath}`;
  const ghHeaders: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "amx-bonds-dashboard", // GitHub rejects requests with no User-Agent
  };

  // 1) get the current file's sha (required to UPDATE an existing file; 404 = create new)
  let sha: string | undefined;
  const getRes = await fetch(`${apiBase}?ref=${encodeURIComponent(branch)}`, {
    headers: ghHeaders,
    cache: "no-store",
  });
  if (getRes.status === 200) {
    const cur = await getRes.json();
    sha = typeof cur?.sha === "string" ? cur.sha : undefined;
  } else if (getRes.status !== 404) {
    const t = await getRes.text();
    return jsonError(502, `GitHub read failed (${getRes.status}): ${t.slice(0, 300)}`);
  }

  // 2) commit the new content
  const content = Buffer.from(JSON.stringify(portfolios, null, 2) + "\n", "utf8").toString("base64");
  const putRes = await fetch(apiBase, {
    method: "PUT",
    headers: { ...ghHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "portfolios: update from dashboard",
      content,
      branch,
      ...(sha ? { sha } : {}),
    }),
  });

  if (!putRes.ok) {
    const t = await putRes.text();
    return jsonError(502, `GitHub write failed (${putRes.status}): ${t.slice(0, 300)}`);
  }

  const out = await putRes.json();
  return new Response(
    JSON.stringify({ ok: true, sha: out?.content?.sha ?? null }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
