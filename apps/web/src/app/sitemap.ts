import type { MetadataRoute } from 'next';
import { ALL_POSTS } from '@/lib/blog';
import { absoluteSiteUrl } from '@/lib/site-origin';

export default function sitemap(): MetadataRoute.Sitemap {
  const staticPages = [
    { url: absoluteSiteUrl(), lastModified: new Date(), changeFrequency: 'weekly' as const, priority: 1 },
    { url: absoluteSiteUrl('/features'), lastModified: new Date(), changeFrequency: 'monthly' as const, priority: 0.8 },
    { url: absoluteSiteUrl('/pricing'), lastModified: new Date(), changeFrequency: 'monthly' as const, priority: 0.8 },
    { url: absoluteSiteUrl('/blog'), lastModified: new Date(), changeFrequency: 'weekly' as const, priority: 0.7 },
    { url: absoluteSiteUrl('/privacy'), lastModified: new Date(), changeFrequency: 'yearly' as const, priority: 0.3 },
    { url: absoluteSiteUrl('/terms'), lastModified: new Date(), changeFrequency: 'yearly' as const, priority: 0.3 },
    { url: absoluteSiteUrl('/login'), lastModified: new Date(), changeFrequency: 'yearly' as const, priority: 0.4 },
    { url: absoluteSiteUrl('/register'), lastModified: new Date(), changeFrequency: 'yearly' as const, priority: 0.6 },
  ];

  const blogPosts = ALL_POSTS.map((post) => ({
    url: absoluteSiteUrl(`/blog/${post.slug}`),
    lastModified: new Date(post.date),
    changeFrequency: 'monthly' as const,
    priority: 0.6,
  }));

  return [...staticPages, ...blogPosts];
}
