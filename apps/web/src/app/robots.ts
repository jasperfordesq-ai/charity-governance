import type { MetadataRoute } from 'next';
import { absoluteSiteUrl } from '@/lib/site-origin';

export default function robots(): MetadataRoute.Robots {
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
