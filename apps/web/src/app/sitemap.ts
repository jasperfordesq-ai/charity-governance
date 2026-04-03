import type { MetadataRoute } from 'next';
import { ALL_POSTS } from '@/lib/blog';

export default function sitemap(): MetadataRoute.Sitemap {
  const base = 'https://charitypilot.ie';

  const staticPages = [
    { url: base, lastModified: new Date(), changeFrequency: 'weekly' as const, priority: 1 },
    { url: `${base}/features`, lastModified: new Date(), changeFrequency: 'monthly' as const, priority: 0.8 },
    { url: `${base}/pricing`, lastModified: new Date(), changeFrequency: 'monthly' as const, priority: 0.8 },
    { url: `${base}/blog`, lastModified: new Date(), changeFrequency: 'weekly' as const, priority: 0.7 },
    { url: `${base}/privacy`, lastModified: new Date(), changeFrequency: 'yearly' as const, priority: 0.3 },
    { url: `${base}/terms`, lastModified: new Date(), changeFrequency: 'yearly' as const, priority: 0.3 },
    { url: `${base}/login`, lastModified: new Date(), changeFrequency: 'yearly' as const, priority: 0.4 },
    { url: `${base}/register`, lastModified: new Date(), changeFrequency: 'yearly' as const, priority: 0.6 },
  ];

  const blogPosts = ALL_POSTS.map((post) => ({
    url: `${base}/blog/${post.slug}`,
    lastModified: new Date(post.date),
    changeFrequency: 'monthly' as const,
    priority: 0.6,
  }));

  return [...staticPages, ...blogPosts];
}
