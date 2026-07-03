import { notFound } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { getPost, getRelatedPosts, ALL_POSTS, formatDate } from '@/lib/blog';
import { ReadingProgress } from '@/components/reading-progress';
import { CopyLinkButton } from '@/components/copy-link-button';
import { BlogPostJsonLd } from '@/components/json-ld';

export function generateStaticParams() {
  return ALL_POSTS.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) return {};
  return {
    title: post.meta.title,
    description: post.meta.excerpt,
    keywords: post.meta.tags,
    openGraph: {
      title: post.meta.title,
      description: post.meta.excerpt,
      type: 'article',
      publishedTime: post.meta.date,
      authors: [post.meta.author],
    },
  };
}

export default async function BlogPostPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) notFound();

  const { meta, Component } = post;
  const related = getRelatedPosts(slug, 2);

  return (
    <div className="bg-white text-gray-950 dark:bg-gray-950 dark:text-gray-50">
      <ReadingProgress />
      <BlogPostJsonLd title={meta.title} excerpt={meta.excerpt} date={meta.date} author={meta.author} slug={meta.slug} />

      <div className="bg-teal-primary text-white dark:bg-teal-dark">
        <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6 md:py-24 lg:px-8">
          <Link
            href="/blog"
            className="group mb-8 inline-flex items-center gap-2 text-sm font-medium text-teal-100 transition-colors hover:text-white"
          >
            <svg
              className="h-4 w-4 transition-transform group-hover:-translate-x-0.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
            </svg>
            Back to blog
          </Link>

          <div className="mb-5 flex flex-wrap items-center gap-3">
            <span className="rounded-md bg-white/15 px-3 py-1 text-xs font-semibold text-teal-50">
              {meta.category}
            </span>
            <span className="text-sm text-teal-100">{meta.readTime}</span>
          </div>

          <h1 className="mb-6 text-3xl font-extrabold leading-tight tracking-normal sm:text-4xl md:text-5xl">
            {meta.title}
          </h1>

          <p className="mb-8 max-w-2xl text-lg leading-relaxed text-teal-50">
            {meta.excerpt}
          </p>

          <div className="flex items-center gap-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-white/15 text-sm font-bold text-white">
              CP
            </div>
            <div>
              <p className="text-sm font-semibold text-white">{meta.author}</p>
              <p className="text-xs text-teal-100">{formatDate(meta.date)}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="prose prose-gray mx-auto max-w-3xl px-4 py-14 dark:prose-invert prose-a:text-teal-primary dark:prose-a:text-teal-bright sm:px-6 md:py-20 lg:px-8">
        <Component />
      </div>

      <div className="mx-auto max-w-3xl px-4 pb-10 sm:px-6 lg:px-8">
        <div className="mb-6 flex items-center gap-3 border-t border-gray-200 pt-8 dark:border-gray-800">
          <span className="text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-400">Share</span>
          <a
            href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(meta.title)}&url=${encodeURIComponent(`https://charitypilot.ie/blog/${meta.slug}`)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-gray-100 text-gray-600 transition-colors hover:bg-gray-200 hover:text-gray-800 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-white"
            aria-label="Share on Twitter"
          >
            <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>
          </a>
          <a
            href={`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(`https://charitypilot.ie/blog/${meta.slug}`)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-gray-100 text-gray-600 transition-colors hover:bg-gray-200 hover:text-gray-800 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-white"
            aria-label="Share on LinkedIn"
          >
            <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" /></svg>
          </a>
          <CopyLinkButton url={`https://charitypilot.ie/blog/${meta.slug}`} />
        </div>

        <div className="flex flex-wrap gap-2">
          {meta.tags.map((tag) => (
            <span
              key={tag}
              className="rounded-md bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-700 dark:bg-gray-900 dark:text-gray-300"
            >
              #{tag}
            </span>
          ))}
        </div>
      </div>

      <div className="border-t border-teal-100 bg-teal-50 dark:border-teal-900 dark:bg-teal-950/30">
        <div className="mx-auto max-w-3xl px-4 py-14 text-center sm:px-6 lg:px-8">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-teal-primary dark:text-teal-bright">
            CharityPilot
          </p>
          <h2 className="mb-3 text-2xl font-bold text-gray-950 dark:text-white">
            Ready to track your compliance?
          </h2>
          <p className="mx-auto mb-6 max-w-md text-gray-700 dark:text-gray-300">
            CharityPilot helps map standards, evidence, registers, deadlines, and board-ready reports.
          </p>
          <div className="flex flex-col justify-center gap-3 sm:flex-row">
            <Link
              href="/register"
              className="inline-flex items-center justify-center rounded-lg bg-teal-primary px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-teal-dark"
            >
              Start your 14-day free trial
            </Link>
            <Link
              href="/pricing"
              className="inline-flex items-center justify-center rounded-lg border border-teal-primary px-6 py-3 text-sm font-semibold text-teal-dark transition-colors hover:bg-teal-50 dark:border-teal-bright dark:text-teal-bright dark:hover:bg-teal-950"
            >
              View pricing
            </Link>
          </div>
        </div>
      </div>

      {related.length > 0 && (
        <div className="border-t border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
          <div className="mx-auto max-w-3xl px-4 py-14 sm:px-6 lg:px-8">
            <h2 className="mb-8 text-xl font-bold text-gray-950 dark:text-white">More from the blog</h2>
            <div className="grid gap-6 sm:grid-cols-2">
              {related.map((r) => (
                <Link
                  key={r.slug}
                  href={`/blog/${r.slug}`}
                  className="group block rounded-lg border border-gray-200 p-6 transition-all hover:border-teal-primary hover:shadow-md dark:border-gray-800 dark:hover:border-teal-bright"
                >
                  <span className="mb-3 inline-block rounded-md bg-teal-primary/10 px-2.5 py-1 text-xs font-semibold text-teal-dark dark:bg-teal-bright/10 dark:text-teal-bright">
                    {r.category}
                  </span>
                  <h3 className="mb-2 text-base font-bold leading-snug text-gray-950 transition-colors group-hover:text-teal-dark dark:text-white dark:group-hover:text-teal-bright">
                    {r.title}
                  </h3>
                  <p className="text-xs text-gray-600 dark:text-gray-400">
                    {formatDate(r.date)} &middot; {r.readTime}
                  </p>
                </Link>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
