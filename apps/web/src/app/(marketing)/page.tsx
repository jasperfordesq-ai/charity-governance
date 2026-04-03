import { Button, Card, CardBody, CardHeader, Link } from '@heroui/react';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'CharityPilot — Charity Governance Made Simple',
  description:
    'The affordable, Ireland-specific governance compliance tool for registered charities. Track your CRA Charities Governance Code compliance, manage documents, and file with confidence.',
  openGraph: {
    title: 'CharityPilot — Charity Governance Made Simple',
    description: 'Over 11,000 Irish charities must comply with the CRA Governance Code. CharityPilot makes it simple.',
    type: 'website',
  },
};

const features = [
  {
    title: 'Compliance Tracker',
    description:
      'Map your charity against all 6 principles and up to 49 standards of the CRA Charities Governance Code. See at a glance which standards you meet, which need work, and what evidence you have on file.',
    icon: (
      <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
  {
    title: 'Document Vault',
    description:
      'Upload and organise your governing documents, policies, minutes, and evidence in one secure place. Tag documents to specific standards so auditors (and your board) can find everything instantly.',
    icon: (
      <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
      </svg>
    ),
  },
  {
    title: 'Board Register',
    description:
      'Maintain an up-to-date register of your board of directors. Track appointment dates, term limits, skill categories, and ensure your board composition meets Governance Code expectations.',
    icon: (
      <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z" />
      </svg>
    ),
  },
  {
    title: 'Deadline Tracker',
    description:
      'Never miss an annual return, CRO filing date, or board meeting. Get advance reminders for every key governance deadline so your charity stays on the right side of the regulator.',
    icon: (
      <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
      </svg>
    ),
  },
  {
    title: 'PDF Export',
    description:
      'Generate professional, print-ready compliance reports with one click. Perfect for board meetings, CRA submissions, and demonstrating governance to funders and stakeholders.',
    icon: (
      <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
      </svg>
    ),
  },
];

const principles = [
  { number: 1, title: 'Advancing Charitable Purpose', colour: 'bg-teal-primary' },
  { number: 2, title: 'Behaving with Integrity', colour: 'bg-teal-dark' },
  { number: 3, title: 'Leading People', colour: 'bg-teal-light' },
  { number: 4, title: 'Exercising Control', colour: 'bg-amber-accent' },
  { number: 5, title: 'Working Effectively', colour: 'bg-teal-primary' },
  { number: 6, title: 'Being Accountable & Transparent', colour: 'bg-teal-dark' },
];

const faqs = [
  {
    question: 'Who is CharityPilot for?',
    answer:
      'CharityPilot is built for Irish registered charities of every size -- from small volunteer-run organisations to larger complex charities with paid staff. If you are on the CRA Register of Charities and need to comply with the Charities Governance Code, CharityPilot is for you.',
  },
  {
    question: 'What is the Charities Governance Code?',
    answer:
      'The Charities Governance Code is a framework introduced by the Charities Regulator Authority (CRA) in Ireland. It sets out minimum standards of governance that every registered charity must meet. There are 6 principles and either 32 core standards (for non-complex charities) or all 49 standards (for complex charities).',
  },
  {
    question: 'How does billing work?',
    answer:
      'We offer monthly and annual billing. Annual plans save you roughly two months compared to paying monthly. Every plan starts with a free 14-day trial -- no credit card required. You can cancel any time from your account settings.',
  },
  {
    question: 'Do I need to be a "Complex" charity?',
    answer:
      'The CRA defines a complex charity as one that has income over EUR 100,000, has paid employees, or operates in multiple jurisdictions. If any of those apply, you should use the Complete plan. If none apply, the Essentials plan covers the 32 core standards that non-complex charities must meet.',
  },
];

export default function LandingPage() {
  return (
    <div>
      {/* Hero Section */}
      <section className="relative overflow-hidden bg-gradient-to-br from-teal-primary via-teal-dark to-teal-primary">
        <div className="absolute inset-0 opacity-10">
          <div className="absolute top-20 left-10 w-72 h-72 bg-amber-accent rounded-full blur-3xl" />
          <div className="absolute bottom-10 right-10 w-96 h-96 bg-teal-light rounded-full blur-3xl" />
        </div>
        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-24 md:py-36">
          <div className="max-w-3xl">
            <h1 className="text-4xl sm:text-5xl md:text-6xl font-extrabold text-white leading-tight tracking-tight">
              Charity governance
              <span className="block text-amber-light">made simple.</span>
            </h1>
            <p className="mt-6 text-lg md:text-xl text-teal-100 max-w-2xl leading-relaxed">
              Over 11,000 Irish charities must comply with the CRA Charities Governance Code.
              CharityPilot gives you a clear, affordable path to compliance -- so you can focus on
              the work that matters.
            </p>
            <div className="mt-10 flex flex-col sm:flex-row gap-4">
              <Button
                as={Link}
                href="/register"
                size="lg"
                className="bg-amber-accent text-gray-900 font-bold text-base px-8 hover:bg-amber-light"
                radius="full"
              >
                Start your 14-day free trial
              </Button>
              <Button
                as={Link}
                href="/features"
                size="lg"
                variant="bordered"
                className="border-white/30 text-white font-semibold text-base px-8 hover:bg-white/10"
                radius="full"
              >
                See how it works
              </Button>
            </div>
            <p className="mt-4 text-sm text-teal-200">No credit card required. Cancel any time.</p>
          </div>
        </div>
      </section>

      {/* Social proof bar */}
      <section className="bg-gray-50 border-b border-gray-100 py-6">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <p className="text-sm text-gray-500 font-medium">
            Built for Irish charities, by people who understand Irish charity governance.
          </p>
        </div>
      </section>

      {/* Pain Points Section */}
      <section className="py-20 md:py-28 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="max-w-3xl mx-auto text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold text-gray-900">
              Governance compliance shouldn&apos;t be this hard
            </h2>
            <p className="mt-4 text-lg text-gray-600 leading-relaxed">
              Most Irish charities are run by dedicated volunteers with limited time and
              resources. But the Charities Governance Code demands real administrative effort.
            </p>
          </div>
          <div className="grid md:grid-cols-3 gap-8">
            {[
              {
                title: 'Scattered documents',
                body: 'Policies, minutes, and evidence stored across email threads, shared drives, and filing cabinets. Nobody knows where anything is when the auditor calls.',
              },
              {
                title: 'Confusing standards',
                body: 'The Governance Code has 6 principles, 49 standards, and pages of guidance notes. Working out which apply to your charity -- and what "compliance" actually looks like -- takes real effort.',
              },
              {
                title: 'Missed deadlines',
                body: 'Annual returns, CRO filings, board reviews, policy renewals. With no central system, it is too easy for deadlines to slip -- and for the regulator to notice.',
              },
            ].map((pain) => (
              <Card
                key={pain.title}
                className="border border-gray-100 shadow-sm hover:shadow-md transition-shadow"
              >
                <CardBody className="p-8">
                  <div className="w-10 h-10 rounded-full bg-red-50 flex items-center justify-center mb-4">
                    <svg className="w-5 h-5 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                    </svg>
                  </div>
                  <h3 className="text-lg font-semibold text-gray-900 mb-2">{pain.title}</h3>
                  <p className="text-gray-600 leading-relaxed">{pain.body}</p>
                </CardBody>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section className="py-20 md:py-28 bg-gray-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="max-w-3xl mx-auto text-center mb-16">
            <p className="text-sm font-semibold text-teal-primary uppercase tracking-wider mb-3">Features</p>
            <h2 className="text-3xl md:text-4xl font-bold text-gray-900">
              Everything you need to stay compliant
            </h2>
            <p className="mt-4 text-lg text-gray-600 leading-relaxed">
              CharityPilot brings all your governance work into one place -- structured around the
              Charities Governance Code so nothing falls through the cracks.
            </p>
          </div>
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
            {features.map((feature) => (
              <Card
                key={feature.title}
                className="border border-gray-100 shadow-sm hover:shadow-md transition-shadow bg-white"
              >
                <CardBody className="p-8">
                  <div className="w-12 h-12 rounded-xl bg-teal-primary/10 text-teal-primary flex items-center justify-center mb-5">
                    {feature.icon}
                  </div>
                  <h3 className="text-lg font-semibold text-gray-900 mb-2">{feature.title}</h3>
                  <p className="text-gray-600 leading-relaxed text-sm">{feature.description}</p>
                </CardBody>
              </Card>
            ))}
          </div>
          <div className="text-center mt-12">
            <Button
              as={Link}
              href="/features"
              variant="bordered"
              className="border-teal-primary text-teal-primary font-semibold hover:bg-teal-primary hover:text-white transition-colors"
              radius="full"
            >
              Explore all features
            </Button>
          </div>
        </div>
      </section>

      {/* 6 Principles Section */}
      <section className="py-20 md:py-28 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="max-w-3xl mx-auto text-center mb-16">
            <p className="text-sm font-semibold text-amber-accent uppercase tracking-wider mb-3">
              The 6 Principles
            </p>
            <h2 className="text-3xl md:text-4xl font-bold text-gray-900">
              Structured around the Charities Governance Code
            </h2>
            <p className="mt-4 text-lg text-gray-600 leading-relaxed">
              CharityPilot organises your entire compliance journey around the six core
              principles of the CRA Charities Governance Code.
            </p>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {principles.map((p) => (
              <div
                key={p.number}
                className="relative rounded-2xl p-6 bg-white border border-gray-100 shadow-sm hover:shadow-md transition-shadow"
              >
                <div
                  className={`w-10 h-10 rounded-full ${p.colour} text-white flex items-center justify-center font-bold text-sm mb-4`}
                >
                  {p.number}
                </div>
                <h3 className="text-lg font-semibold text-gray-900">{p.title}</h3>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing Preview */}
      <section className="py-20 md:py-28 bg-gradient-to-br from-gray-50 to-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <p className="text-sm font-semibold text-teal-primary uppercase tracking-wider mb-3">Pricing</p>
          <h2 className="text-3xl md:text-4xl font-bold text-gray-900 mb-4">
            Simple, honest pricing
          </h2>
          <p className="text-lg text-gray-600 max-w-2xl mx-auto leading-relaxed mb-8">
            Two plans. No hidden fees. Choose the one that fits your charity -- and start with a
            free 14-day trial, no credit card required.
          </p>
          <div className="grid md:grid-cols-2 gap-8 max-w-3xl mx-auto">
            <Card className="border-2 border-gray-200 shadow-sm">
              <CardHeader className="flex flex-col items-center pt-8 pb-2">
                <p className="text-sm font-semibold text-teal-primary uppercase tracking-wider">Essentials</p>
                <p className="mt-2 text-4xl font-bold text-gray-900">
                  &euro;19<span className="text-lg font-normal text-gray-500">/month</span>
                </p>
                <p className="text-sm text-gray-500">or &euro;190/year (save &euro;38)</p>
              </CardHeader>
              <CardBody className="px-8 pb-8 text-center">
                <p className="text-gray-600 mb-6">For non-complex charities. Covers the 32 core standards.</p>
                <Button
                  as={Link}
                  href="/pricing"
                  variant="bordered"
                  className="border-teal-primary text-teal-primary font-semibold w-full"
                  radius="full"
                >
                  View details
                </Button>
              </CardBody>
            </Card>
            <Card className="border-2 border-teal-primary shadow-md relative overflow-visible">
              <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-amber-accent text-gray-900 text-xs font-bold px-4 py-1 rounded-full">
                Most Popular
              </div>
              <CardHeader className="flex flex-col items-center pt-8 pb-2">
                <p className="text-sm font-semibold text-teal-primary uppercase tracking-wider">Complete</p>
                <p className="mt-2 text-4xl font-bold text-gray-900">
                  &euro;39<span className="text-lg font-normal text-gray-500">/month</span>
                </p>
                <p className="text-sm text-gray-500">or &euro;390/year (save &euro;78)</p>
              </CardHeader>
              <CardBody className="px-8 pb-8 text-center">
                <p className="text-gray-600 mb-6">For complex charities. All 49 standards covered.</p>
                <Button
                  as={Link}
                  href="/pricing"
                  className="bg-teal-primary text-white font-semibold w-full"
                  radius="full"
                >
                  View details
                </Button>
              </CardBody>
            </Card>
          </div>
        </div>
      </section>

      {/* FAQ Section */}
      <section className="py-20 md:py-28 bg-white">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold text-gray-900">
              Frequently asked questions
            </h2>
          </div>
          <div className="space-y-3">
            {faqs.map((faq) => (
              <details key={faq.question} className="group border border-gray-100 rounded-xl overflow-hidden">
                <summary className="flex items-center justify-between cursor-pointer px-6 py-5 text-lg font-semibold text-gray-900 hover:bg-gray-50 transition-colors list-none">
                  {faq.question}
                  <svg className="w-5 h-5 text-gray-400 transition-transform group-open:rotate-180 flex-shrink-0 ml-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                  </svg>
                </summary>
                <p className="px-6 pb-5 text-gray-600 leading-relaxed">{faq.answer}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="py-20 md:py-28 bg-teal-primary">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h2 className="text-3xl md:text-4xl font-bold text-white mb-4">
            Ready to simplify your governance?
          </h2>
          <p className="text-teal-100 text-lg mb-8 leading-relaxed">
            Start your 14-day free trial -- no credit card required. See how CharityPilot can help
            your charity stay compliant, organised, and confident.
          </p>
          <Button
            as={Link}
            href="/register"
            size="lg"
            className="bg-amber-accent text-gray-900 font-bold text-base px-10 hover:bg-amber-light"
            radius="full"
          >
            Start your 14-day free trial
          </Button>
        </div>
      </section>

    </div>
  );
}
