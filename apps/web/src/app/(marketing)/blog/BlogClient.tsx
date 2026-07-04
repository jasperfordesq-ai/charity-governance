'use client';

import { useState } from 'react';
import { Button, Input } from '@heroui/react';
import Link from 'next/link';
import { ArrowRight, BookOpen, FileText, Search, ShieldCheck } from 'lucide-react';
import { getCategories, formatDate } from '@/lib/blog';
import type { PostMeta } from '@/lib/blog';
import { primaryActionButtonClasses } from '@/components/ui/action-button';

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
        <ArrowRight
          className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
          strokeWidth={2}
          aria-hidden="true"
        />
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
      <div className="mb-6 max-w-md">
        <Input
          type="search"
          placeholder="Search articles..."
          value={search}
          onValueChange={setSearch}
          aria-label="Search blog articles"
          radius="md"
          variant="bordered"
          startContent={<Search className="h-4 w-4 text-gray-400 dark:text-gray-400" strokeWidth={2} aria-hidden="true" />}
          classNames={{
            inputWrapper: 'border-gray-300 bg-white hover:border-teal-primary focus-within:!border-teal-primary dark:border-gray-700 dark:bg-gray-900 dark:hover:border-teal-bright dark:focus-within:!border-teal-bright',
            input: 'text-sm text-gray-800 placeholder:text-gray-400 dark:text-gray-100 dark:placeholder:text-gray-500',
          }}
        />
      </div>

      <div className="mb-12 flex flex-wrap gap-2" role="tablist" aria-label="Filter by category">
        {categories.map((cat) => (
          <Button
            key={cat}
            type="button"
            role="tab"
            aria-selected={activeCategory === cat}
            size="sm"
            radius="md"
            variant={activeCategory === cat ? 'solid' : 'flat'}
            onPress={() => setActiveCategory(cat)}
            className={`font-semibold ${
              activeCategory === cat
                ? 'bg-teal-primary text-white dark:bg-teal-bright dark:text-gray-950'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800'
            }`}
          >
            {cat}
          </Button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-6 py-16 text-center dark:border-gray-700 dark:bg-gray-900">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-lg bg-white text-gray-400 dark:bg-gray-950 dark:text-gray-400">
            <FileText className="h-7 w-7" strokeWidth={1.5} aria-hidden="true" />
          </div>
          <p className="mb-1 font-semibold text-gray-950 dark:text-white">No articles found</p>
          <p className="mx-auto max-w-sm text-sm text-gray-600 dark:text-gray-300">
            Try a broader search term or switch back to all categories.
          </p>
          <Button
            type="button"
            size="sm"
            radius="md"
            variant="bordered"
            onPress={() => {
              setSearch('');
              setActiveCategory('All');
            }}
            className="mt-5 border-teal-primary font-semibold text-teal-primary hover:bg-teal-primary hover:text-white dark:border-teal-bright dark:text-teal-bright dark:hover:bg-teal-bright dark:hover:text-gray-950"
          >
            Clear filters
          </Button>
        </div>
      ) : (
        <>
          {featured && (
            <div className="mb-10">
              <p className="mb-4 inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-400">
                <BookOpen className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
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
          <ShieldCheck className="h-6 w-6" strokeWidth={1.5} aria-hidden="true" />
        </div>
        <h2 className="mb-2 text-xl font-bold text-gray-950 dark:text-white">Want governance tips in your inbox?</h2>
        <p className="mx-auto mb-6 max-w-md text-sm text-gray-700 dark:text-gray-300">
          Start a CharityPilot trial and keep your governance work connected to practical Irish charity guidance.
        </p>
        <Button
          as={Link}
          href="/register"
          radius="md"
          className={primaryActionButtonClasses('px-6 font-semibold')}
        >
          Start free 14-day trial
        </Button>
      </div>
    </div>
  );
}
