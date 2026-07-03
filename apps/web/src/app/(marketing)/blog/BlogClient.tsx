'use client';

import { useState } from 'react';
import Link from 'next/link';
import { getCategories, formatDate } from '@/lib/blog';
import type { PostMeta } from '@/lib/blog';

function PostCard({ post, featured = false }: { post: PostMeta; featured?: boolean }) {
  return (
    <Link
      href={`/blog/${post.slug}`}
      className={`group block rounded-lg border border-gray-200 bg-white transition-all hover:border-teal-primary hover:shadow-md dark:border-gray-800 dark:bg-gray-900 dark:hover:border-teal-bright ${
        featured ? 'p-8 md:p-10' : 'p-6'
      }`}
    >
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <span className="rounded-md bg-teal-primary/10 px-3 py-1 text-xs font-semibold text-teal-dark dark:bg-teal-bright/10 dark:text-teal-bright">
          {post.category}
        </span>
        <span className="text-sm text-gray-600 dark:text-gray-300">{formatDate(post.date)}</span>
        <span className="hidden text-gray-300 dark:text-gray-400 sm:inline">&bull;</span>
        <span className="hidden text-sm text-gray-600 dark:text-gray-300 sm:inline">{post.readTime}</span>
      </div>

      <h2
        className={`mb-3 font-bold leading-snug text-gray-950 transition-colors group-hover:text-teal-dark dark:text-white dark:group-hover:text-teal-bright ${
          featured ? 'text-2xl md:text-3xl' : 'text-lg'
        }`}
      >
        {post.title}
      </h2>

      <p className={`mb-5 leading-relaxed text-gray-700 dark:text-gray-300 ${featured ? 'text-base' : 'text-sm'}`}>
        {post.excerpt}
      </p>

      <div className="inline-flex items-center gap-1.5 text-sm font-semibold text-teal-primary transition-colors group-hover:text-teal-dark dark:text-teal-bright">
        Read article
        <svg
          className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
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

export function BlogClient({ posts }: { posts: PostMeta[] }) {
  const categories = getCategories();
  const [activeCategory, setActiveCategory] = useState('All');
  const [search, setSearch] = useState('');

  const filtered = posts
    .filter((p) => activeCategory === 'All' || p.category === activeCategory)
    .filter((p) => {
      if (!search.trim()) return true;
      const q = search.toLowerCase();
      return (
        p.title.toLowerCase().includes(q) ||
        p.excerpt.toLowerCase().includes(q) ||
        p.tags.some((t) => t.toLowerCase().includes(q))
      );
    });

  const [featured, ...rest] = filtered;

  return (
    <div className="mx-auto max-w-4xl px-4 py-14 sm:px-6 lg:px-8">
      <div className="mb-6">
        <div className="relative max-w-md">
          <svg className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400 dark:text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
          </svg>
          <input
            type="search"
            placeholder="Search articles..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border border-gray-300 bg-white py-2.5 pl-10 pr-4 text-sm text-gray-800 placeholder-gray-400 transition-colors focus:border-teal-primary focus:outline-none focus:ring-2 focus:ring-teal-primary/20 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder-gray-500 dark:focus:border-teal-bright dark:focus:ring-teal-bright/20"
            aria-label="Search blog articles"
          />
        </div>
      </div>

      <div className="mb-12 flex flex-wrap gap-2" role="tablist" aria-label="Filter by category">
        {categories.map((cat) => (
          <button
            key={cat}
            type="button"
            role="tab"
            aria-selected={activeCategory === cat}
            onClick={() => setActiveCategory(cat)}
            className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
              activeCategory === cat
                ? 'bg-teal-primary text-white dark:bg-teal-bright dark:text-gray-950'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800'
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-6 py-16 text-center dark:border-gray-700 dark:bg-gray-900">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-lg bg-white text-gray-400 dark:bg-gray-950 dark:text-gray-400">
            <svg className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
            </svg>
          </div>
          <p className="mb-1 font-semibold text-gray-950 dark:text-white">No articles found</p>
          <p className="mx-auto max-w-sm text-sm text-gray-600 dark:text-gray-300">
            Try a broader search term or switch back to all categories.
          </p>
          <button
            type="button"
            onClick={() => {
              setSearch('');
              setActiveCategory('All');
            }}
            className="mt-5 rounded-lg border border-teal-primary px-4 py-2 text-sm font-semibold text-teal-primary hover:bg-teal-primary hover:text-white dark:border-teal-bright dark:text-teal-bright dark:hover:bg-teal-bright dark:hover:text-gray-950"
          >
            Clear filters
          </button>
        </div>
      ) : (
        <>
          {featured && (
            <div className="mb-10">
              <p className="mb-4 text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-400">
                Latest article
              </p>
              <PostCard post={featured} featured />
            </div>
          )}

          {rest.length > 0 && (
            <div>
              <p className="mb-4 text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-400">
                {activeCategory === 'All' ? 'More articles' : 'All articles'}
              </p>
              <div className="grid gap-6 sm:grid-cols-2">
                {rest.map((post) => (
                  <PostCard key={post.slug} post={post} />
                ))}
              </div>
            </div>
          )}
        </>
      )}

      <div className="mt-20 rounded-lg border border-teal-100 bg-teal-50 p-8 text-center dark:border-teal-900 dark:bg-teal-950/30 md:p-10">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-white text-teal-primary dark:bg-gray-950 dark:text-teal-bright">
          <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
          </svg>
        </div>
        <h2 className="mb-2 text-xl font-bold text-gray-950 dark:text-white">Want governance tips in your inbox?</h2>
        <p className="mx-auto mb-6 max-w-md text-sm text-gray-700 dark:text-gray-300">
          Start a CharityPilot trial and keep your governance work connected to practical Irish charity guidance.
        </p>
        <Link
          href="/register"
          className="inline-flex items-center rounded-lg bg-teal-primary px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-teal-dark dark:bg-teal-bright dark:text-gray-950"
        >
          Start free 14-day trial
        </Link>
      </div>
    </div>
  );
}
