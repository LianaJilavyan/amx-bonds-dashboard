/** @type {import('next').NextConfig} */
const nextConfig = {
  // history.json (~5 MB) is read at runtime by the /api/history/[isin] route via
  // fs from process.cwd()/data. This line guarantees Vercel bundles that file into
  // the route's serverless function. (Next.js 15 key; on 14.x nest it under
  // `experimental: { outputFileTracingIncludes: {...} }` instead.)
  outputFileTracingIncludes: {
    "/api/history/[isin]": ["./data/history.json"],
  },
};

export default nextConfig;
