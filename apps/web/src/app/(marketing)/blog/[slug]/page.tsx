import { notFound } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowLeft, Share2 } from 'lucide-react';
import { getPost, getRelatedPosts, ALL_POSTS, formatDate } from '@/lib/blog';
import { absoluteSiteUrl } from '@/lib/site-origin';
import { ReadingProgress } from '@/components/reading-progress';
import { CopyLinkButton } from '@/components/copy-link-button';
import { BlogPostJsonLd } from '@/components/json-ld';
import { primaryActionButtonClasses } from '@/components/ui/action-button';

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
  const canonicalUrl = absoluteSiteUrl(`/blog/${meta.slug}`);

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
            <ArrowLeft className="h-4 w-4 transition-transform group-hover:-translate-x-0.5" aria-hidden="true" />
            Back to blog
          </Link>

          <div className="mb-5 flex flex-wrap items-center gap-3">
            <span className="rounded-md bg-white px-3 py-1 text-xs font-semibold text-teal-900 shadow-sm">
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
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-white text-sm font-bold text-teal-900 shadow-sm">
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
            href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(meta.title)}&url=${encodeURIComponent(canonicalUrl)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-gray-100 text-gray-600 transition-colors hover:bg-gray-200 hover:text-gray-800 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-white"
            aria-label="Share on Twitter"
          >
            <Share2 className="h-4 w-4" aria-hidden="true" />
          </a>
          <a
            href={`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(canonicalUrl)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-gray-100 text-gray-600 transition-colors hover:bg-gray-200 hover:text-gray-800 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-white"
            aria-label="Share on LinkedIn"
          >
            <Share2 className="h-4 w-4" aria-hidden="true" />
          </a>
          <CopyLinkButton url={canonicalUrl} />
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
              className={primaryActionButtonClasses(
                'inline-flex items-center justify-center rounded-lg px-6 py-3 text-sm font-semibold transition-colors',
              )}
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
