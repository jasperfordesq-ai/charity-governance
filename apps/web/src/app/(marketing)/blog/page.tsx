import type { Metadata } from 'next';
import { ALL_POSTS } from '@/lib/blog';
import { BlogClient } from './BlogClient';

export const metadata: Metadata = {
  title: 'Blog | Charity Governance Insights',
  description:
    'Practical guidance on Irish charity governance, the CRA Charities Governance Code, annual reporting, and trustee responsibilities.',
};

export default function BlogPage() {
  return (
    <div className="bg-white text-gray-950 dark:bg-gray-950 dark:text-gray-50">
      <div className="border-b border-gray-200 bg-white py-20 dark:border-gray-800 dark:bg-gray-950 md:py-28">
        <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
          <p className="mb-4 text-sm font-semibold uppercase tracking-wider text-teal-primary dark:text-teal-bright">
            Charity Governance Insights
          </p>
          <h1 className="mb-5 text-4xl font-extrabold leading-tight tracking-normal text-gray-950 dark:text-white md:text-5xl">
            The CharityPilot Blog
          </h1>
          <p className="max-w-2xl text-lg leading-relaxed text-gray-700 dark:text-gray-300">
            Practical guidance on Irish charity governance, the CRA Charities Governance Code,
            annual reporting, trustee responsibilities, and evidence-led administration.
          </p>
        </div>
      </div>

      <BlogClient posts={ALL_POSTS} />
    </div>
  );
}
