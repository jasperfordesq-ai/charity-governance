import type { NextConfig } from 'next';

const scriptSrc = ["'self'", "'unsafe-inline'"];
if (process.env.NODE_ENV !== 'production') {
  scriptSrc.push("'unsafe-eval'");
}

const connectSrc =
  process.env.NODE_ENV === 'production'
    ? `'self' ${process.env.NEXT_PUBLIC_API_URL ?? 'https://api.charitypilot.ie'}`
    : "'self' http://localhost:3001 http://localhost:3003 ws://localhost:3003";

const contentSecurityPolicyDirectives = [
  "default-src 'self'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  `script-src ${scriptSrc.join(' ')}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob:",
  `connect-src ${connectSrc}`,
  "form-action 'self'",
];

if (process.env.NODE_ENV === 'production') {
  contentSecurityPolicyDirectives.push('upgrade-insecure-requests');
}

const contentSecurityPolicy = contentSecurityPolicyDirectives.join('; ');

const nextConfig: NextConfig = {
  transpilePackages: ['@charitypilot/shared'],
  async headers() {
    const securityHeaders = [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      {
        key: 'Permissions-Policy',
        value: 'camera=(), microphone=(), geolocation=(), payment=()',
      },
      { key: 'Content-Security-Policy', value: contentSecurityPolicy },
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
