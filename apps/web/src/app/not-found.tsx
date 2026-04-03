import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="min-h-screen bg-white flex flex-col items-center justify-center px-4">
      <div className="text-center max-w-lg">
        {/* Logo */}
        <Link href="/" className="inline-block mb-10">
          <span className="text-3xl font-extrabold text-teal-primary tracking-tight">
            CharityPilot
          </span>
        </Link>

        {/* 404 illustration */}
        <div className="flex items-center justify-center mb-8">
          <span className="text-8xl font-extrabold text-gray-100 select-none">404</span>
        </div>

        <h1 className="text-2xl font-bold text-gray-900 mb-3">Page not found</h1>
        <p className="text-gray-500 leading-relaxed mb-8">
          The page you&apos;re looking for doesn&apos;t exist or may have been moved.
          Let&apos;s get you back on course.
        </p>

        <div className="flex flex-col sm:flex-row items-center gap-3">
          <Link
            href="/"
            className="inline-flex items-center gap-2 bg-teal-primary text-white font-semibold px-6 py-3 rounded-full hover:bg-teal-dark transition-colors"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
            </svg>
            Back to home
          </Link>
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-2 border border-teal-primary text-teal-primary font-semibold px-6 py-3 rounded-full hover:bg-teal-primary hover:text-white transition-colors"
          >
            Go to dashboard
          </Link>
        </div>
        <p className="mt-6 text-sm text-gray-400">
          Need help?{' '}
          <a href="mailto:support@charitypilot.ie" className="text-teal-primary hover:underline">
            Contact support
          </a>
        </p>
      </div>
    </div>
  );
}
