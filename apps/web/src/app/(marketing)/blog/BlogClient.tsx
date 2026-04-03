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
        <span className="bg-teal-primary/10 text-teal-700 text-xs font-semibold px-3 py-1 rounded-full">
          {post.category}
        </span>
        <span className="text-gray-400 text-sm">{formatDate(post.date)}</span>
        <span className="text-gray-300 hidden sm:inline">&bull;</span>
        <span className="text-gray-400 text-sm hidden sm:inline">{post.readTime}</span>
      </div>

      <h2
        className={`font-bold text-gray-900 group-hover:text-teal-700 transition-colors leading-snug mb-3 ${
          featured ? 'text-2xl md:text-3xl' : 'text-lg'
        }`}
      >
        {post.title}
      </h2>

      <p className={`text-gray-600 leading-relaxed mb-5 ${featured ? 'text-base' : 'text-sm'}`}>
        {post.excerpt}
      </p>

      <div className="inline-flex items-center gap-1.5 text-sm font-semibold text-teal-600 group-hover:text-teal-800 transition-colors">
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

  const filtered =
    activeCategory === 'All'
      ? posts
      : posts.filter((p) => p.category === activeCategory);

  const [featured, ...rest] = filtered;

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-14">

      {/* ── Category tabs ── */}
      <div className="flex flex-wrap gap-2 mb-12">
        {categories.map((cat) => (
          <button
            key={cat}
            onClick={() => setActiveCategory(cat)}
            className={`px-4 py-2 rounded-full text-sm font-semibold transition-colors ${
              activeCategory === cat
                ? 'bg-teal-600 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="text-gray-400 text-center py-20">No articles in this category yet.</p>
      ) : (
        <>
          {/* ── Featured post ── */}
          {featured && (
            <div className="mb-10">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">
                Latest article
              </p>
              <PostCard post={featured} featured />
            </div>
          )}

          {/* ── Remaining posts ── */}
          {rest.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">
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
          className="inline-flex items-center bg-teal-600 text-white font-semibold text-sm px-6 py-3 rounded-full hover:bg-teal-700 transition-colors"
        >
          Start free 14-day trial
        </Link>
      </div>
    </div>
  );
}
