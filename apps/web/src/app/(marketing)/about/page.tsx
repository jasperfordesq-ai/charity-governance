import type { Metadata } from 'next';
import { SOURCE_REPOSITORY_URL } from '@/components/legal-attribution';

export const metadata: Metadata = {
  title: 'About CharityPilot',
  description:
    'About CharityPilot, its copyright attribution to Jasper Ford, GPL license, and public source repository.',
};

export default function AboutPage() {
  return (
    <div className="bg-white text-gray-950 dark:bg-gray-950 dark:text-gray-50">
      <section className="border-b border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
        <div className="mx-auto max-w-4xl px-4 py-16 sm:px-6 md:py-20 lg:px-8">
          <p className="mb-4 text-sm font-semibold uppercase tracking-wider text-teal-primary dark:text-teal-bright">
            About CharityPilot
          </p>
          <h1 className="text-4xl font-extrabold leading-tight tracking-normal text-gray-950 dark:text-white sm:text-5xl">
            Irish charity governance software with public source attribution.
          </h1>
          <p className="mt-6 text-lg leading-8 text-gray-700 dark:text-gray-300">
            CharityPilot helps Irish registered charities keep governance evidence,
            registers, deadlines, and board review material organised in one review-ready
            workspace.
          </p>
        </div>
      </section>

      <section className="bg-gray-50 py-16 dark:bg-gray-900 md:py-20">
        <div className="mx-auto grid max-w-5xl gap-8 px-4 sm:px-6 md:grid-cols-2 lg:px-8">
          <div>
            <h2 className="text-2xl font-bold text-gray-950 dark:text-white">
              Copyright and IP holder
            </h2>
            <p className="mt-4 leading-7 text-gray-700 dark:text-gray-300">
              CharityPilot is copyright (C) 2026 Jasper Ford. Jasper Ford is the
              IP holder for the CharityPilot software and source code.
            </p>
          </div>

          <div>
            <h2 className="text-2xl font-bold text-gray-950 dark:text-white">
              License and source
            </h2>
            <p className="mt-4 leading-7 text-gray-700 dark:text-gray-300">
              CharityPilot is licensed under GPL-3.0-or-later. The canonical public
              source repository is
              {' '}
              <a
                href={SOURCE_REPOSITORY_URL}
                target="_blank"
                rel="noreferrer"
                className="font-semibold text-teal-primary underline decoration-current/40 underline-offset-4 transition-colors hover:text-teal-dark dark:text-teal-bright dark:hover:text-teal-light"
              >
                https://github.com/jasperfordesq-ai/charity-governance
              </a>
              .
            </p>
          </div>
        </div>
      </section>

      <section className="bg-white py-16 dark:bg-gray-950 md:py-20">
        <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
          <h2 className="text-2xl font-bold text-gray-950 dark:text-white">
            Attribution for users and distributors
          </h2>
          <p className="mt-4 leading-7 text-gray-700 dark:text-gray-300">
            Anyone using, modifying, deploying, or conveying CharityPilot should preserve
            the copyright notice, GPL license notice, and source repository link. The
            application footer includes this visible attribution so users can trace the
            project back to its public source.
          </p>
        </div>
      </section>
    </div>
  );
}
