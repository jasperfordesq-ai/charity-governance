import Link from 'next/link';
import type { ReactNode } from 'react';

export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      {/* Navigation */}
      <header className="sticky top-0 z-50 bg-white/90 backdrop-blur-md border-b border-gray-100">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            {/* Logo */}
            <Link href="/" className="flex items-center gap-2 group">
              <svg
                className="w-7 h-7 text-teal-primary shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="9" strokeWidth={1.5} />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 2v2m0 16v2M2 12h2m16 0h2m-4.343-7.657-1.414 1.414M7.757 16.243l-1.414 1.414M19.657 19.657l-1.414-1.414M7.757 7.757 6.343 6.343"
                />
                <circle cx="12" cy="12" r="2.5" fill="currentColor" strokeWidth={0} />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="m12 12 3-5"
                  strokeWidth={2}
                />
              </svg>
              <span className="text-xl font-extrabold text-teal-primary tracking-tight group-hover:text-teal-dark transition-colors">
                CharityPilot
              </span>
            </Link>

            {/* Nav links */}
            <nav className="hidden md:flex items-center gap-8" aria-label="Main navigation">
              <Link
                href="/features"
                className="text-gray-600 hover:text-teal-primary transition-colors text-sm font-medium"
              >
                Features
              </Link>
              <Link
                href="/pricing"
                className="text-gray-600 hover:text-teal-primary transition-colors text-sm font-medium"
              >
                Pricing
              </Link>
              <Link
                href="/blog"
                className="text-gray-600 hover:text-teal-primary transition-colors text-sm font-medium"
              >
                Blog
              </Link>
              <Link
                href="/login"
                className="text-gray-600 hover:text-teal-primary transition-colors text-sm font-medium"
              >
                Sign in
              </Link>
            </nav>

            {/* CTA */}
            <Link
              href="/register"
              className="hidden md:inline-flex items-center bg-teal-primary text-white font-semibold text-sm px-5 py-2.5 rounded-full hover:bg-teal-dark transition-colors"
            >
              Start free trial
            </Link>

            {/* Mobile menu button — minimal, just shows the CTA on mobile */}
            <Link
              href="/register"
              className="md:hidden inline-flex items-center bg-teal-primary text-white font-semibold text-xs px-4 py-2 rounded-full hover:bg-teal-dark transition-colors"
            >
              Free trial
            </Link>
          </div>
        </div>
      </header>

      {/* Page content */}
      <main className="flex-1">{children}</main>

      {/* Footer */}
      <footer className="bg-gray-900 text-gray-400 py-14">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid md:grid-cols-4 gap-10 mb-10">
            {/* Brand */}
            <div className="md:col-span-2">
              <p className="text-xl font-bold text-white mb-3">CharityPilot</p>
              <p className="text-sm leading-relaxed max-w-sm text-gray-400">
                The affordable, Ireland-specific governance compliance tool for registered
                charities. A product of Project Nexus Ltd, Skibbereen, Co. Cork.
              </p>
            </div>

            {/* Product links */}
            <div>
              <p className="text-xs font-semibold text-white uppercase tracking-wider mb-4">
                Product
              </p>
              <ul className="space-y-2 text-sm">
                <li>
                  <Link href="/features" className="hover:text-white transition-colors">
                    Features
                  </Link>
                </li>
                <li>
                  <Link href="/pricing" className="hover:text-white transition-colors">
                    Pricing
                  </Link>
                </li>
                <li>
                  <Link href="/blog" className="hover:text-white transition-colors">
                    Blog
                  </Link>
                </li>
              </ul>
            </div>

            {/* Legal links */}
            <div>
              <p className="text-xs font-semibold text-white uppercase tracking-wider mb-4">
                Legal
              </p>
              <ul className="space-y-2 text-sm">
                <li>
                  <Link href="/privacy" className="hover:text-white transition-colors">
                    Privacy Policy
                  </Link>
                </li>
                <li>
                  <Link href="/terms" className="hover:text-white transition-colors">
                    Terms of Service
                  </Link>
                </li>
              </ul>
            </div>
          </div>

          <div className="pt-8 border-t border-gray-800 text-sm text-center text-gray-500">
            <p>&copy; 2026 Project Nexus Ltd. All rights reserved.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
