import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingExcludes: {
    '*': ['patch-review/**/*'],
  },
  turbopack: {
    root: '/',
  },
};

export default nextConfig;
