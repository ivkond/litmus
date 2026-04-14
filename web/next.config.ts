import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  serverExternalPackages: ['dockerode', 'ssh2'],
};

export default nextConfig;
