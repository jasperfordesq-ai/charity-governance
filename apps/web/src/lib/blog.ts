import type { ComponentType } from 'react';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface PostMeta {
  slug: string;
  title: string;
  excerpt: string;
  date: string; // ISO 8601 e.g. "2026-03-20"
  author: string;
  category: string;
  readTime: string;
  tags: string[];
}

export interface Post {
  meta: PostMeta;
  Component: ComponentType;
}

/* ------------------------------------------------------------------ */
/*  Registry — add every new post here                                 */
/* ------------------------------------------------------------------ */

import UnderstandingGovernanceCode, {
  meta as understandingGovernanceCodeMeta,
} from '@/content/blog/understanding-the-charities-governance-code';

import SimpleVsComplex, {
  meta as simpleVsComplexMeta,
} from '@/content/blog/simple-vs-complex-charity-classification';

import AnnualReporting, {
  meta as annualReportingMeta,
} from '@/content/blog/annual-reporting-guide-irish-charities';

import EssentialPolicies, {
  meta as essentialPoliciesMeta,
} from '@/content/blog/essential-trustee-policies';

export const BLOG_REGISTRY: Record<string, Post> = {
  [understandingGovernanceCodeMeta.slug]: {
    meta: understandingGovernanceCodeMeta,
    Component: UnderstandingGovernanceCode,
  },
  [simpleVsComplexMeta.slug]: {
    meta: simpleVsComplexMeta,
    Component: SimpleVsComplex,
  },
  [annualReportingMeta.slug]: {
    meta: annualReportingMeta,
    Component: AnnualReporting,
  },
  [essentialPoliciesMeta.slug]: {
    meta: essentialPoliciesMeta,
    Component: EssentialPolicies,
  },
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** All posts sorted newest first */
export const ALL_POSTS: PostMeta[] = Object.values(BLOG_REGISTRY)
  .map((p) => p.meta)
  .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

export function getPost(slug: string): Post | undefined {
  return BLOG_REGISTRY[slug];
}

export function getCategories(): string[] {
  return ['All', ...Array.from(new Set(ALL_POSTS.map((p) => p.category)))];
}

export function getRelatedPosts(slug: string, limit = 2): PostMeta[] {
  const current = BLOG_REGISTRY[slug]?.meta;
  if (!current) return [];
  return ALL_POSTS.filter(
    (p) => p.slug !== slug && p.category === current.category,
  )
    .slice(0, limit)
    .concat(
      ALL_POSTS.filter(
        (p) => p.slug !== slug && p.category !== current.category,
      ).slice(0, Math.max(0, limit - 2)),
    )
    .slice(0, limit);
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IE', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}
