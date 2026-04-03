import { notFound } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { getPost, getRelatedPosts, ALL_POSTS, formatDate } from '@/lib/blog';

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

      {/* ── Tags ── */}
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 pb-10">
        <div className="flex flex-wrap gap-2 pt-8 border-t border-gray-100">
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
          <p className="text-xs font-semibold text-teal-600 uppercase tracking-wider mb-3">
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
              className="inline-flex items-center justify-center bg-teal-600 text-white font-semibold text-sm px-6 py-3 rounded-full hover:bg-teal-700 transition-colors"
            >
              Start your 14-day free trial
            </Link>
            <Link
              href="/pricing"
              className="inline-flex items-center justify-center border border-teal-600 text-teal-700 font-semibold text-sm px-6 py-3 rounded-full hover:bg-teal-50 transition-colors"
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
                  <span className="inline-block bg-teal-primary/10 text-teal-700 text-xs font-semibold px-2.5 py-1 rounded-full mb-3">
                    {r.category}
                  </span>
                  <h3 className="text-base font-bold text-gray-900 group-hover:text-teal-700 transition-colors leading-snug mb-2">
                    {r.title}
                  </h3>
                  <p className="text-xs text-gray-400">{formatDate(r.date)} · {r.readTime}</p>
                </Link>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
