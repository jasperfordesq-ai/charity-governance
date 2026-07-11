import type { MetadataRoute } from 'next';
import { absoluteSiteUrl } from '@/lib/site-origin';

export default function robots(): MetadataRoute.Robots {
  if (process.env.NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE === 'personal-server') {
    return {
      rules: [{ userAgent: '*', disallow: '/' }],
    };
  }

  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/dashboard/', '/api/', '/billing/'],
      },
    ],
    sitemap: absoluteSiteUrl('/sitemap.xml'),
  };
}
