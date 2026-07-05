import type { NextConfig } from 'next';

function resolveNextDistDir(): string {
  const distDir = process.env.NEXT_DIST_DIR?.trim();
  if (!distDir) return '.next';

  if (/[\\/]/.test(distDir) || distDir === '.' || distDir === '..' || distDir.includes('..')) {
    throw new Error('NEXT_DIST_DIR must be a project-local directory name.');
  }

  return distDir;
}

const nextConfig: NextConfig = {
  agentRules: false,
  distDir: resolveNextDistDir(),
  experimental: {
    cpus: 1,
    webpackBuildWorker: false,
    workerThreads: true,
  },
  poweredByHeader: false,
  transpilePackages: ['@charitypilot/shared'],
  webpack(config, { dev }) {
    if (dev) {
      config.watchOptions = {
        ...config.watchOptions,
        ignored: [
          ...(Array.isArray(config.watchOptions?.ignored) ? config.watchOptions.ignored : []),
          '**/e2e/test-results/**',
          '**/e2e/playwright-report/**',
        ],
      };
    }

    return config;
  },
  async headers() {
    const securityHeaders = [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      {
        key: 'Permissions-Policy',
        value: 'camera=(), microphone=(), geolocation=(), payment=()',
      },
    ];

    if (process.env.NODE_ENV === 'production') {
      securityHeaders.push({
        key: 'Strict-Transport-Security',
        value: 'max-age=63072000; includeSubDomains; preload',
      });
    }

    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
