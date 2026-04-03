import type { Metadata } from 'next';
import { ALL_POSTS } from '@/lib/blog';
import { BlogClient } from './BlogClient';

export const metadata: Metadata = {
  title: 'Blog — Charity Governance Insights',
  description:
    'Practical guidance on Irish charity governance, the CRA Charities Governance Code, annual reporting, and trustee responsibilities.',
};

export default function BlogPage() {
  return (
    <div className="bg-white">
      {/* ── Header ── */}
      <div className="bg-gradient-to-br from-gray-900 to-gray-800 text-white py-20 md:py-28">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <p className="text-teal-400 text-sm font-semibold uppercase tracking-wider mb-4">
            Charity Governance Insights
          </p>
          <h1 className="text-4xl md:text-5xl font-extrabold leading-tight tracking-tight mb-5">
            The CharityPilot Blog
          </h1>
          <p className="text-gray-300 text-lg leading-relaxed max-w-2xl">
            Practical, accurate guidance on Irish charity governance — the CRA Charities
            Governance Code, annual reporting, trustee responsibilities, and more.
          </p>
        </div>
      </div>

      {/* ── Filterable post list (client component) ── */}
      <BlogClient posts={ALL_POSTS} />
    </div>
  );
}
