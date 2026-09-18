import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `next dev` locks its build directory, so a second dev server in this checkout (the
  // Playwright suite's, on its own database) needs a directory of its own. Unset: `.next`.
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
};

export default nextConfig;
