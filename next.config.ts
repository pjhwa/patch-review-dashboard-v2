import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingExcludes: {
    '*': ['patch-review/**/*'],
  },
};

export default nextConfig;
