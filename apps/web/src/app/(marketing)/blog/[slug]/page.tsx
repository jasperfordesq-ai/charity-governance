import { notFound } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { getPost, getRelatedPosts, ALL_POSTS, formatDate } from '@/lib/blog';
import { ReadingProgress } from '@/components/reading-progress';
import { CopyLinkButton } from '@/components/copy-link-button';
import { BlogPostJsonLd } from '@/components/json-ld';

/* ------------------------------------------------------------------ */
/*  Static params — pre-render every known slug                        */
/* ------------------------------------------------------------------ */

export function generateStaticParams() {
  return ALL_POSTS.map((p) => ({ slug: p.slug }));
}

/* ------------------------------------------------------------------ */
/*  Metadata                                                           */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*  Page component                                                      */
/* ------------------------------------------------------------------ */

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
    <div className="bg-white">
      <ReadingProgress />
      <BlogPostJsonLd title={meta.title} excerpt={meta.excerpt} date={meta.date} author={meta.author} slug={meta.slug} />
      {/* ── Hero ── */}
      <div className="bg-gradient-to-br from-teal-700 to-teal-900 text-white">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-16 md:py-24">
          {/* Back link */}
          <Link
            href="/blog"
            className="inline-flex items-center gap-2 text-teal-200 hover:text-white transition-colors text-sm font-medium mb-8 group"
          >
            <svg
              className="w-4 h-4 group-hover:-translate-x-0.5 transition-transform"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
            </svg>
            Back to blog
          </Link>

          {/* Category + read time */}
          <div className="flex flex-wrap items-center gap-3 mb-5">
            <span className="bg-teal-600/60 text-teal-100 text-xs font-semibold px-3 py-1 rounded-full">
              {meta.category}
            </span>
            <span className="text-teal-300 text-sm">{meta.readTime}</span>
          </div>

          {/* Title */}
          <h1 className="text-3xl sm:text-4xl md:text-5xl font-extrabold leading-tight tracking-tight mb-6">
            {meta.title}
          </h1>

          {/* Excerpt */}
          <p className="text-lg text-teal-100 leading-relaxed max-w-2xl mb-8">
            {meta.excerpt}
          </p>

          {/* Author + date */}
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 rounded-full bg-teal-600 flex items-center justify-center text-sm font-bold text-white">
              CP
            </div>
            <div>
              <p className="text-sm font-semibold text-white">{meta.author}</p>
              <p className="text-xs text-teal-300">{formatDate(meta.date)}</p>
            </div>
          </div>
        </div>
      </div>

      {/* ── Article body ── */}
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-14 md:py-20">
        <Component />
      </div>

      {/* ── Share + Tags ── */}
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 pb-10">
        {/* Share buttons */}
        <div className="flex items-center gap-3 pt-8 border-t border-gray-100 mb-6">
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Share</span>
          <a
            href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(meta.title)}&url=${encodeURIComponent(`https://charitypilot.ie/blog/${meta.slug}`)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="w-8 h-8 rounded-full bg-gray-100 hover:bg-gray-200 flex items-center justify-center text-gray-500 hover:text-gray-700 transition-colors"
            aria-label="Share on Twitter"
          >
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>
          </a>
          <a
            href={`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(`https://charitypilot.ie/blog/${meta.slug}`)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="w-8 h-8 rounded-full bg-gray-100 hover:bg-gray-200 flex items-center justify-center text-gray-500 hover:text-gray-700 transition-colors"
            aria-label="Share on LinkedIn"
          >
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" /></svg>
          </a>
          <CopyLinkButton url={`https://charitypilot.ie/blog/${meta.slug}`} />
        </div>

        {/* Tags */}
        <div className="flex flex-wrap gap-2">
          {meta.tags.map((tag) => (
            <span
              key={tag}
              className="bg-gray-100 text-gray-600 text-xs font-medium px-3 py-1.5 rounded-full"
            >
              #{tag}
            </span>
          ))}
        </div>
      </div>

      {/* ── CTA ── */}
      <div className="bg-teal-50 border-t border-teal-100">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-14 text-center">
          <p className="text-xs font-semibold text-teal-primary uppercase tracking-wider mb-3">
            CharityPilot
          </p>
          <h2 className="text-2xl font-bold text-gray-900 mb-3">
            Ready to track your compliance?
          </h2>
          <p className="text-gray-600 mb-6 max-w-md mx-auto">
            CharityPilot makes it simple to map your charity against all 49 CRA standards,
            manage evidence, and generate board-ready reports.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link
              href="/register"
              className="inline-flex items-center justify-center bg-teal-primary text-white font-semibold text-sm px-6 py-3 rounded-full hover:bg-teal-dark transition-colors"
            >
              Start your 14-day free trial
            </Link>
            <Link
              href="/pricing"
              className="inline-flex items-center justify-center border border-teal-primary text-teal-dark font-semibold text-sm px-6 py-3 rounded-full hover:bg-teal-50 transition-colors"
            >
              View pricing
            </Link>
          </div>
        </div>
      </div>

      {/* ── Related posts ── */}
      {related.length > 0 && (
        <div className="border-t border-gray-100 bg-white">
          <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-14">
            <h2 className="text-xl font-bold text-gray-900 mb-8">More from the blog</h2>
            <div className="grid sm:grid-cols-2 gap-6">
              {related.map((r) => (
                <Link
                  key={r.slug}
                  href={`/blog/${r.slug}`}
                  className="group block border border-gray-100 rounded-2xl p-6 hover:border-teal-200 hover:shadow-md transition-all"
                >
                  <span className="inline-block bg-teal-primary/10 text-teal-dark text-xs font-semibold px-2.5 py-1 rounded-full mb-3">
                    {r.category}
                  </span>
                  <h3 className="text-base font-bold text-gray-900 group-hover:text-teal-dark transition-colors leading-snug mb-2">
                    {r.title}
                  </h3>
                  <p className="text-xs text-gray-500">{formatDate(r.date)} · {r.readTime}</p>
                </Link>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
