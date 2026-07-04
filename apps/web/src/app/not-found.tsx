import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

export default function NotFound() {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex flex-col items-center justify-center px-4">
      <div className="text-center max-w-lg">
        {/* Logo */}
        <Link href="/" className="inline-block mb-10">
          <span className="text-3xl font-extrabold text-teal-primary tracking-tight">
            CharityPilot
          </span>
        </Link>

        {/* 404 illustration */}
        <div className="flex items-center justify-center mb-8">
          <span className="text-8xl font-extrabold text-gray-100 dark:text-gray-800 select-none">404</span>
        </div>

        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-3">Page not found</h1>
        <p className="text-gray-500 dark:text-gray-400 leading-relaxed mb-8">
          The page you&apos;re looking for doesn&apos;t exist or may have been moved.
          Let&apos;s get you back on course.
        </p>

        <div className="flex flex-col sm:flex-row items-center gap-3">
          <Link
            href="/"
            className="inline-flex items-center gap-2 bg-teal-primary text-white font-semibold px-6 py-3 rounded-full hover:bg-teal-dark transition-colors"
          >
            <ArrowLeft className="w-4 h-4" strokeWidth={2} aria-hidden="true" />
            Back to home
          </Link>
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-2 border border-teal-primary dark:border-teal-light text-teal-primary dark:text-teal-light font-semibold px-6 py-3 rounded-full hover:bg-teal-primary hover:text-white transition-colors"
          >
            Go to dashboard
          </Link>
        </div>
        <p className="mt-6 text-sm text-gray-500 dark:text-gray-400">
          Need help?{' '}
          <a href="mailto:support@charitypilot.ie" className="text-teal-primary hover:text-teal-dark dark:text-teal-light hover:underline">
            Contact support
          </a>
        </p>
      </div>
    </div>
  );
}
