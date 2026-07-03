import { Button, Card, CardBody, CardHeader, Link } from '@/components/heroui-client';
import type { Metadata } from 'next';
import { OrganisationJsonLd, FaqJsonLd } from '@/components/json-ld';

export const metadata: Metadata = {
  title: 'CharityPilot | Irish Charity Governance Software',
  description:
    'Ireland-specific governance compliance software for registered charities. Track CRA Governance Code readiness, evidence, registers, deadlines, and board signoff.',
  openGraph: {
    title: 'CharityPilot | Irish Charity Governance Software',
    description:
      'CharityPilot helps Irish charities keep CRA Governance Code evidence, registers, deadlines, and board signoff review-ready.',
    type: 'website',
  },
};

const features = [
  {
    title: 'Compliance Tracker',
    description:
      'Map your charity against all 6 principles and up to 49 standards of the CRA Charities Governance Code, with status, evidence, actions, and explanations in one place.',
    icon: (
      <svg className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
  {
    title: 'Evidence Vault',
    description:
      'Organise governing documents, policies, minutes, and supporting evidence by standard so trustees can see what is ready for annual review.',
    icon: (
      <svg className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
      </svg>
    ),
  },
  {
    title: 'Board Register',
    description:
      'Keep trustee appointment dates, terms, induction, conduct, conflicts, and board composition signals visible before governance reviews.',
    icon: (
      <svg className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z" />
      </svg>
    ),
  },
  {
    title: 'Deadline Tracker',
    description:
      'Track annual returns, CRO filings, policy reviews, board meetings, and custom governance dates with reminders and completion history.',
    icon: (
      <svg className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
      </svg>
    ),
  },
  {
    title: 'Board-Ready Reports',
    description:
      'Generate printable compliance reports with standards, evidence summaries, approval notes, and minute references for trustee review.',
    icon: (
      <svg className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
      </svg>
    ),
  },
];

const principles = [
  { number: 1, title: 'Advancing Charitable Purpose' },
  { number: 2, title: 'Behaving with Integrity' },
  { number: 3, title: 'Leading People' },
  { number: 4, title: 'Exercising Control' },
  { number: 5, title: 'Working Effectively' },
  { number: 6, title: 'Being Accountable & Transparent' },
];

const workflowSignals = [
  { label: 'Standards mapped', value: '32 or 49' },
  { label: 'Evidence linked', value: 'By standard' },
  { label: 'Board signoff', value: 'Minutes ready' },
  { label: 'Deadline view', value: 'CRA, CRO, custom' },
];

const faqs = [
  {
    question: 'Who is CharityPilot for?',
    answer:
      'CharityPilot is built for Irish registered charities of every size, from small volunteer-run organisations to larger charities with staff. If your charity needs to evidence its Charities Governance Code work, CharityPilot is designed for that workflow.',
  },
  {
    question: 'What is the Charities Governance Code?',
    answer:
      'The Charities Governance Code is a framework from the Charities Regulator in Ireland. It sets out minimum standards of governance that every registered charity must meet. CharityPilot helps organise the records, evidence, and review notes that support that work.',
  },
  {
    question: 'How does billing work?',
    answer:
      'We offer monthly and annual billing. Annual plans save roughly two months compared to paying monthly. Every plan starts with a free 14-day trial, no credit card required. You can cancel from your account settings.',
  },
  {
    question: 'Is CharityPilot legal advice?',
    answer:
      'No. CharityPilot is administrative software for tracking governance work and evidence. It is not a substitute for legal or regulatory advice, and trustees remain responsible for reviewing their charity position.',
  },
];

export default function LandingPage() {
  return (
    <div className="bg-white text-gray-950 dark:bg-gray-950 dark:text-gray-50">
      <OrganisationJsonLd />
      <FaqJsonLd faqs={faqs} />

      <section className="border-b border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
        <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 md:py-28 lg:px-8">
          <div className="max-w-4xl">
            <p className="mb-4 text-sm font-semibold uppercase tracking-wider text-teal-primary dark:text-teal-bright">
              Irish charity governance compliance
            </p>
            <h1 className="text-4xl font-extrabold leading-tight tracking-normal text-gray-950 dark:text-white sm:text-5xl md:text-6xl">
              CharityPilot keeps your Governance Code evidence review-ready.
            </h1>
            <p className="mt-6 max-w-3xl text-lg leading-8 text-gray-700 dark:text-gray-200 md:text-xl">
              Bring standards, evidence, board signoff, registers, and annual reporting deadlines
              into one calm workspace built for Irish registered charities.
            </p>
            <div className="mt-10 flex flex-col gap-3 sm:flex-row">
              <Button
                as={Link}
                href="/register"
                size="lg"
                className="bg-teal-primary px-8 text-base font-bold text-white hover:bg-teal-dark"
                radius="lg"
              >
                Start your 14-day free trial
              </Button>
              <Button
                as={Link}
                href="/features"
                size="lg"
                variant="bordered"
                className="border-gray-300 px-8 text-base font-semibold text-gray-900 hover:border-teal-primary hover:text-teal-primary dark:border-gray-700 dark:text-gray-100 dark:hover:border-teal-bright dark:hover:text-teal-bright"
                radius="lg"
              >
                See the workflow
              </Button>
            </div>
            <p className="mt-4 text-sm text-gray-600 dark:text-gray-300">
              No credit card required. Built for trustees, charity administrators, and governance leads.
            </p>
          </div>

          <div className="mt-14 grid gap-3 border-t border-gray-200 pt-6 dark:border-gray-800 sm:grid-cols-2 lg:grid-cols-4">
            {workflowSignals.map((item) => (
              <div key={item.label} className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-800 dark:bg-gray-900">
                <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  {item.label}
                </p>
                <p className="mt-2 text-base font-semibold text-gray-950 dark:text-white">{item.value}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-b border-gray-200 bg-gray-50 py-6 dark:border-gray-800 dark:bg-gray-900">
        <div className="mx-auto max-w-7xl px-4 text-center sm:px-6 lg:px-8">
          <p className="text-sm font-medium text-gray-700 dark:text-gray-200">
            Evidence-led software for Irish charities preparing board reviews, annual returns, and regulator queries.
          </p>
        </div>
      </section>

      <section className="bg-white py-20 dark:bg-gray-950 md:py-28">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mx-auto mb-14 max-w-3xl text-center">
            <h2 className="text-3xl font-bold text-gray-950 dark:text-white md:text-4xl">
              Governance work is easier when the evidence has a home
            </h2>
            <p className="mt-4 text-lg leading-8 text-gray-700 dark:text-gray-300">
              Many charities are run by committed trustees and administrators with limited time.
              CharityPilot turns governance admin into a visible, reviewable workflow.
            </p>
          </div>
          <div className="grid gap-6 md:grid-cols-3">
            {[
              {
                title: 'Find evidence quickly',
                body: 'Keep policies, minutes, approvals, and notes linked to the standards they support instead of buried in email threads and shared folders.',
              },
              {
                title: 'Know what needs review',
                body: 'See which standards are ready, which need action, and which need an explanation before your annual board review.',
              },
              {
                title: 'Keep deadlines visible',
                body: 'Track annual returns, CRO filings, policy reviews, meetings, and custom governance dates in one place.',
              },
            ].map((pain) => (
              <Card key={pain.title} className="border border-gray-200 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-900">
                <CardBody className="p-7">
                  <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
                    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <h3 className="mb-2 text-lg font-semibold text-gray-950 dark:text-white">{pain.title}</h3>
                  <p className="leading-7 text-gray-700 dark:text-gray-300">{pain.body}</p>
                </CardBody>
              </Card>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-gray-50 py-20 dark:bg-gray-900 md:py-28">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mx-auto mb-14 max-w-3xl text-center">
            <p className="mb-3 text-sm font-semibold uppercase tracking-wider text-teal-primary dark:text-teal-bright">Product workflow</p>
            <h2 className="text-3xl font-bold text-gray-950 dark:text-white md:text-4xl">
              Everything trustees expect to see in a governance review
            </h2>
            <p className="mt-4 text-lg leading-8 text-gray-700 dark:text-gray-300">
              CharityPilot is structured around the Charities Governance Code, not generic task management.
            </p>
          </div>
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {features.map((feature) => (
              <Card key={feature.title} className="border border-gray-200 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-950">
                <CardBody className="p-7">
                  <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-lg bg-teal-primary/10 text-teal-primary dark:bg-teal-bright/10 dark:text-teal-bright">
                    {feature.icon}
                  </div>
                  <h3 className="mb-2 text-lg font-semibold text-gray-950 dark:text-white">{feature.title}</h3>
                  <p className="text-sm leading-7 text-gray-700 dark:text-gray-300">{feature.description}</p>
                </CardBody>
              </Card>
            ))}
          </div>
          <div className="mt-12 text-center">
            <Button
              as={Link}
              href="/features"
              variant="bordered"
              className="border-teal-primary font-semibold text-teal-primary hover:bg-teal-primary hover:text-white dark:border-teal-bright dark:text-teal-bright dark:hover:bg-teal-bright dark:hover:text-gray-950"
              radius="lg"
            >
              Explore all features
            </Button>
          </div>
        </div>
      </section>

      <section className="bg-white py-20 dark:bg-gray-950 md:py-28">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mx-auto mb-14 max-w-3xl text-center">
            <p className="mb-3 text-sm font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-300">
              The 6 principles
            </p>
            <h2 className="text-3xl font-bold text-gray-950 dark:text-white md:text-4xl">
              A workspace shaped by the Charities Governance Code
            </h2>
            <p className="mt-4 text-lg leading-8 text-gray-700 dark:text-gray-300">
              Standards, evidence, actions, and explanations stay tied to the principle they support.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {principles.map((p) => (
              <div
                key={p.number}
                className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900"
              >
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-teal-primary text-sm font-bold text-white">
                  {p.number}
                </div>
                <h3 className="text-lg font-semibold text-gray-950 dark:text-white">{p.title}</h3>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-gray-50 py-20 dark:bg-gray-900 md:py-28">
        <div className="mx-auto max-w-7xl px-4 text-center sm:px-6 lg:px-8">
          <p className="mb-3 text-sm font-semibold uppercase tracking-wider text-teal-primary dark:text-teal-bright">Pricing</p>
          <h2 className="mb-4 text-3xl font-bold text-gray-950 dark:text-white md:text-4xl">
            Simple pricing for charity budgets
          </h2>
          <p className="mx-auto mb-8 max-w-2xl text-lg leading-8 text-gray-700 dark:text-gray-300">
            Two plans. No hidden fees. Start with a free 14-day trial and choose the coverage your charity needs.
          </p>
          <div className="mx-auto grid max-w-3xl gap-6 md:grid-cols-2">
            <Card className="border-2 border-gray-200 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-950">
              <CardHeader className="flex flex-col items-center px-8 pb-2 pt-8">
                <p className="text-sm font-semibold uppercase tracking-wider text-teal-primary dark:text-teal-bright">Essentials</p>
                <p className="mt-2 text-4xl font-bold text-gray-950 dark:text-white">
                  &euro;19<span className="text-lg font-normal text-gray-600 dark:text-gray-300">/month</span>
                </p>
                <p className="text-sm text-gray-600 dark:text-gray-300">or &euro;190/year (save &euro;38)</p>
              </CardHeader>
              <CardBody className="px-8 pb-8 text-center">
                <p className="mb-6 text-gray-700 dark:text-gray-300">For non-complex charities. Covers the 32 core standards.</p>
                <Button
                  as={Link}
                  href="/pricing"
                  variant="bordered"
                  className="w-full border-teal-primary font-semibold text-teal-primary dark:border-teal-bright dark:text-teal-bright"
                  radius="lg"
                >
                  View details
                </Button>
              </CardBody>
            </Card>
            <Card className="relative overflow-visible border-2 border-teal-primary bg-white shadow-md dark:border-teal-bright dark:bg-gray-950">
              <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-lg bg-amber-accent px-4 py-1 text-xs font-bold text-gray-950">
                Most popular
              </div>
              <CardHeader className="flex flex-col items-center px-8 pb-2 pt-8">
                <p className="text-sm font-semibold uppercase tracking-wider text-teal-primary dark:text-teal-bright">Complete</p>
                <p className="mt-2 text-4xl font-bold text-gray-950 dark:text-white">
                  &euro;39<span className="text-lg font-normal text-gray-600 dark:text-gray-300">/month</span>
                </p>
                <p className="text-sm text-gray-600 dark:text-gray-300">or &euro;390/year (save &euro;78)</p>
              </CardHeader>
              <CardBody className="px-8 pb-8 text-center">
                <p className="mb-6 text-gray-700 dark:text-gray-300">For charities applying all 49 standards and broader governance registers.</p>
                <Button as={Link} href="/pricing" className="w-full bg-teal-primary font-semibold text-white" radius="lg">
                  View details
                </Button>
              </CardBody>
            </Card>
          </div>
        </div>
      </section>

      <section className="bg-white py-20 dark:bg-gray-950 md:py-28">
        <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
          <div className="mb-12 text-center">
            <h2 className="text-3xl font-bold text-gray-950 dark:text-white md:text-4xl">
              Frequently asked questions
            </h2>
          </div>
          <div className="space-y-3">
            {faqs.map((faq) => (
              <details key={faq.question} className="group overflow-hidden rounded-lg border border-gray-200 dark:border-gray-800">
                <summary className="flex cursor-pointer list-none items-center justify-between px-6 py-5 text-lg font-semibold text-gray-950 transition-colors hover:bg-gray-50 dark:text-white dark:hover:bg-gray-900">
                  {faq.question}
                  <svg className="ml-3 h-5 w-5 flex-shrink-0 text-gray-400 transition-transform group-open:rotate-180 dark:text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                  </svg>
                </summary>
                <p className="px-6 pb-5 leading-7 text-gray-700 dark:text-gray-300">{faq.answer}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-teal-primary py-20 dark:bg-teal-dark md:py-28">
        <div className="mx-auto max-w-3xl px-4 text-center sm:px-6 lg:px-8">
          <h2 className="mb-4 text-3xl font-bold text-white md:text-4xl">
            Start with your real governance workflow
          </h2>
          <p className="mb-8 text-lg leading-8 text-teal-50">
            Try CharityPilot for 14 days with no credit card required. Bring standards, evidence,
            registers, deadlines, and board signoff into one place.
          </p>
          <Button as={Link} href="/register" size="lg" className="bg-amber-accent px-10 text-base font-bold text-gray-950 hover:bg-amber-light" radius="lg">
            Start your 14-day free trial
          </Button>
        </div>
      </section>
    </div>
  );
}
