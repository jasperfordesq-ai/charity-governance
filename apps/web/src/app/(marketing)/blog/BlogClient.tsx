'use client';

import { useState } from 'react';
import Link from 'next/link';
import { getCategories, formatDate } from '@/lib/blog';
import type { PostMeta } from '@/lib/blog';

/* ------------------------------------------------------------------ */
/*  Post card                                                          */
/* ------------------------------------------------------------------ */

function PostCard({ post, featured = false }: { post: PostMeta; featured?: boolean }) {
  return (
    <Link
      href={`/blog/${post.slug}`}
      className={`group block border border-gray-100 rounded-2xl bg-white hover:border-teal-200 hover:shadow-md transition-all ${
        featured ? 'p-8 md:p-10' : 'p-6'
      }`}
    >
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <span className="bg-teal-primary/10 text-teal-dark text-xs font-semibold px-3 py-1 rounded-full">
          {post.category}
        </span>
        <span className="text-gray-500 text-sm">{formatDate(post.date)}</span>
        <span className="text-gray-300 hidden sm:inline">&bull;</span>
        <span className="text-gray-500 text-sm hidden sm:inline">{post.readTime}</span>
      </div>

      <h2
        className={`font-bold text-gray-900 group-hover:text-teal-dark transition-colors leading-snug mb-3 ${
          featured ? 'text-2xl md:text-3xl' : 'text-lg'
        }`}
      >
        {post.title}
      </h2>

      <p className={`text-gray-600 leading-relaxed mb-5 ${featured ? 'text-base' : 'text-sm'}`}>
        {post.excerpt}
      </p>

      <div className="inline-flex items-center gap-1.5 text-sm font-semibold text-teal-primary group-hover:text-teal-dark transition-colors">
        Read article
        <svg
          className="w-4 h-4 group-hover:translate-x-0.5 transition-transform"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
        </svg>
      </div>
    </Link>
  );
}

/* ------------------------------------------------------------------ */
/*  Client component — handles category filtering                      */
/* ------------------------------------------------------------------ */

export function BlogClient({ posts }: { posts: PostMeta[] }) {
  const categories = getCategories();
  const [activeCategory, setActiveCategory] = useState('All');
  const [search, setSearch] = useState('');

  const filtered = posts
    .filter((p) => activeCategory === 'All' || p.category === activeCategory)
    .filter((p) => {
      if (!search.trim()) return true;
      const q = search.toLowerCase();
      return p.title.toLowerCase().includes(q) || p.excerpt.toLowerCase().includes(q) || p.tags.some((t) => t.toLowerCase().includes(q));
    });

  const [featured, ...rest] = filtered;

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-14">

      {/* ── Search ── */}
      <div className="mb-6">
        <div className="relative max-w-md">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
          </svg>
          <input
            type="search"
            placeholder="Search articles..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 border border-gray-300 rounded-xl text-sm text-gray-700 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-teal-primary/20 focus:border-teal-primary transition-colors"
            aria-label="Search blog articles"
          />
        </div>
      </div>

      {/* ── Category tabs ── */}
      <div className="flex flex-wrap gap-2 mb-12" role="tablist" aria-label="Filter by category">
        {categories.map((cat) => (
          <button
            key={cat}
            role="tab"
            aria-selected={activeCategory === cat}
            onClick={() => setActiveCategory(cat)}
            className={`px-4 py-2 rounded-full text-sm font-semibold transition-colors ${
              activeCategory === cat
                ? 'bg-teal-primary text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-20">
          <div className="w-14 h-14 rounded-full bg-gray-100 flex items-center justify-center mx-auto mb-4">
            <svg className="w-7 h-7 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
            </svg>
          </div>
          <p className="text-gray-500 font-medium mb-1">No articles found</p>
          <p className="text-sm text-gray-500">Try a different search term or browse all categories.</p>
        </div>
      ) : (
        <>
          {/* ── Featured post ── */}
          {featured && (
            <div className="mb-10">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-4">
                Latest article
              </p>
              <PostCard post={featured} featured />
            </div>
          )}

          {/* ── Remaining posts ── */}
          {rest.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-4">
                {activeCategory === 'All' ? 'More articles' : 'All articles'}
              </p>
              <div className="grid sm:grid-cols-2 gap-6">
                {rest.map((post) => (
                  <PostCard key={post.slug} post={post} />
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* ── Newsletter nudge ── */}
      <div className="mt-20 bg-teal-50 border border-teal-100 rounded-2xl p-8 md:p-10 text-center">
        <div className="w-12 h-12 rounded-full bg-teal-100 flex items-center justify-center mx-auto mb-4">
          <svg className="w-6 h-6 text-teal-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
          </svg>
        </div>
        <h2 className="text-xl font-bold text-gray-900 mb-2">Want governance tips in your inbox?</h2>
        <p className="text-gray-600 text-sm mb-6 max-w-md mx-auto">
          We publish practical Irish charity governance guides regularly. Start a free
          CharityPilot trial and we&apos;ll keep you up to date.
        </p>
        <Link
          href="/register"
          className="inline-flex items-center bg-teal-primary text-white font-semibold text-sm px-6 py-3 rounded-full hover:bg-teal-dark transition-colors"
        >
          Start free 14-day trial
        </Link>
      </div>
    </div>
  );
}
