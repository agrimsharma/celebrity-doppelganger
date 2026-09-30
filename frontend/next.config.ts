import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Docker/Kubernetes builds (frontend/Dockerfile) use the self-contained server; Vercel doesn't need it
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
};

export default nextConfig;
