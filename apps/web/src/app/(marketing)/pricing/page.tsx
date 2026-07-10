import { Button, Card, CardBody, CardHeader, Link } from '@/components/heroui-client';
import type { Metadata } from 'next';
import { Check, ChevronDown, X } from 'lucide-react';
import { primaryActionButtonClassName } from '@/components/ui/action-button';
import { statusPanelClassName } from '@/components/ui/status';

export const metadata: Metadata = {
  title: 'Pricing - CharityPilot',
  description:
    'Simple, honest pricing for Irish charity governance compliance. Start with a free 14-day trial.',
};

const plans = [
  {
    name: 'Essentials',
    audience: 'For non-complex charities',
    monthlyPrice: 19,
    annualPrice: 190,
    annualSaving: 38,
    highlight: false,
    description:
      'Everything you need to comply with the 32 core standards of the Charities Governance Code. Perfect for smaller, volunteer-run charities.',
    features: [
      'Compliance Tracker (32 core standards)',
      'Document Vault (2 GB storage)',
      'Board Register',
      'Deadline Tracker with email reminders',
      'Printable compliance reports',
      'Single organisation',
      'Up to 5 team members',
      'Email support',
    ],
  },
  {
    name: 'Complete',
    audience: 'For complex charities',
    monthlyPrice: 39,
    annualPrice: 390,
    annualSaving: 78,
    highlight: true,
    description:
      'Full coverage of all 49 standards, with advanced features for organisations with paid staff, higher income, or multi-jurisdiction operations.',
    features: [
      'Compliance Tracker (all 49 standards)',
      'Document Vault (10 GB storage)',
      'Governance registers for risks, conflicts, complaints, and fundraising',
      'Deadline Tracker with verified email reminders',
      'Printable compliance reports with evidence summaries',
      'Single organisation',
      'Unlimited team members',
      'Priority email support',
      'Annual Report readiness and financial controls tracking',
    ],
  },
];

const comparisonRows = [
  { feature: 'Governance Code standards', essentials: '32 core', complete: 'All 49' },
  { feature: 'Document storage', essentials: '2 GB', complete: '10 GB' },
  { feature: 'Team members', essentials: 'Up to 5', complete: 'Unlimited' },
  { feature: 'Compliance Tracker', essentials: true, complete: true },
  { feature: 'Document Vault', essentials: true, complete: true },
  { feature: 'Board Register', essentials: true, complete: true },
  { feature: 'Governance registers', essentials: false, complete: true },
  { feature: 'Deadline Tracker', essentials: true, complete: true },
  { feature: 'Email reminders', essentials: true, complete: true },
  { feature: 'Reminder delivery log', essentials: true, complete: true },
  { feature: 'Printable report export', essentials: true, complete: true },
  { feature: 'Evidence summaries in report', essentials: true, complete: true },
  { feature: 'Annual Report readiness', essentials: false, complete: true },
  { feature: 'Support', essentials: 'Email', complete: 'Priority email' },
];

function renderCell(value: boolean | string) {
  if (typeof value === 'boolean') {
    return value ? (
      <Check className="w-5 h-5 text-teal-primary" aria-hidden="true" />
    ) : (
      <X className="w-5 h-5 text-gray-400 dark:text-gray-400" aria-hidden="true" />
    );
  }
  return <span className="text-sm text-gray-700 dark:text-gray-300">{value}</span>;
}

export default function PricingPage() {
  return (
    <div className="min-h-screen bg-white text-gray-950 dark:bg-gray-950 dark:text-gray-50">
      {/* Hero */}
      <section className="border-b border-gray-200 bg-white py-16 dark:border-gray-800 dark:bg-gray-950 md:py-24">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h1 className="text-4xl md:text-5xl font-extrabold text-gray-950 dark:text-white tracking-normal">
            Simple, honest pricing
          </h1>
          <p className="mt-4 text-lg text-gray-700 dark:text-gray-300 max-w-2xl mx-auto leading-relaxed">
            Choose the plan that fits your charity. Both include a 14-day free trial -- no credit
            card required.
          </p>
        </div>
      </section>

      {/* Pricing Cards */}
      <section className="pb-20 -mt-4">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid md:grid-cols-2 gap-8">
            {plans.map((plan) => (
              <Card
                key={plan.name}
                className={statusPanelClassName(
                  plan.highlight ? 'brand' : 'neutral',
                  `relative overflow-visible border-2 ${
                    plan.highlight
                      ? 'border-teal-primary shadow-lg dark:border-teal-bright'
                      : 'shadow-sm'
                  }`,
                )}
              >
                {plan.highlight && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-amber-accent text-gray-950 text-xs font-bold px-4 py-1 rounded-lg">
                    Most Popular
                  </div>
                )}
                <CardHeader className="flex flex-col items-center pt-10 pb-4 px-8">
                  <p className="text-sm font-semibold text-teal-primary dark:text-teal-bright uppercase tracking-wider">
                    {plan.name}
                  </p>
                  <p className="text-xs text-gray-600 dark:text-gray-300 mt-1">{plan.audience}</p>
                  <div className="mt-4">
                    <span className="text-5xl font-bold text-gray-950 dark:text-white">&euro;{plan.monthlyPrice}</span>
                    <span className="text-lg text-gray-600 dark:text-gray-300">/month</span>
                  </div>
                  <p className="text-sm text-gray-600 dark:text-gray-300 mt-1">
                    or &euro;{plan.annualPrice}/year{' '}
                    <span className="text-teal-primary dark:text-teal-bright font-medium">(save &euro;{plan.annualSaving})</span>
                  </p>
                </CardHeader>
                <CardBody className="px-8 pb-10">
                  <p className="text-gray-700 dark:text-gray-300 text-sm leading-relaxed mb-6 text-center">
                    {plan.description}
                  </p>
                  <Button
                    as={Link}
                    href="/register"
                    className={`w-full font-semibold ${
                      plan.highlight
                        ? primaryActionButtonClassName
                        : 'bg-white border-2 border-teal-primary text-teal-primary hover:bg-teal-primary hover:text-white dark:bg-gray-950 dark:border-teal-bright dark:text-teal-bright dark:hover:bg-teal-bright dark:hover:text-gray-950'
                    }`}
                    radius="lg"
                    size="lg"
                  >
                    Start 14-day free trial
                  </Button>
                  <ul className="mt-8 space-y-3">
                    {plan.features.map((feature) => (
                      <li key={feature} className="flex items-start gap-3 text-sm text-gray-700 dark:text-gray-300">
                        <Check className="w-5 h-5 text-teal-primary" aria-hidden="true" />
                        <span>{feature}</span>
                      </li>
                    ))}
                  </ul>
                </CardBody>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* Feature Comparison Table */}
      <section className="py-20 bg-gray-50 dark:bg-gray-900">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <h2 className="text-2xl md:text-3xl font-bold text-gray-950 dark:text-white text-center mb-12">
            Feature comparison
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b-2 border-gray-200 dark:border-gray-800">
                  <th className="text-left py-4 pr-4 text-sm font-semibold text-gray-950 dark:text-white w-1/2">
                    Feature
                  </th>
                  <th className="text-center py-4 px-4 text-sm font-semibold text-gray-950 dark:text-white">
                    Essentials
                  </th>
                  <th className="text-center py-4 pl-4 text-sm font-semibold text-teal-primary dark:text-teal-bright">
                    Complete
                  </th>
                </tr>
              </thead>
              <tbody>
                {comparisonRows.map((row) => (
                  <tr key={row.feature} className="border-b border-gray-200 dark:border-gray-800">
                    <td className="py-4 pr-4 text-sm text-gray-700 dark:text-gray-300">{row.feature}</td>
                    <td className="py-4 px-4">
                      <div className="flex justify-center">{renderCell(row.essentials)}</div>
                    </td>
                    <td className="py-4 pl-4">
                      <div className="flex justify-center">{renderCell(row.complete)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="py-20 bg-white dark:bg-gray-950">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
          <h2 className="text-2xl md:text-3xl font-bold text-gray-950 dark:text-white text-center mb-12">
            Pricing questions
          </h2>
          <div className="space-y-3">
            {[
              { q: 'How do I know if my charity is \u201ccomplex\u201d?', a: 'The Charities Regulator expects trustees to look at the charity size, income, staffing, activities, structure, and risk profile. If your charity needs the additional standards, choose the Complete plan.' },
              { q: 'Can I switch plans later?', a: 'Existing Stripe-managed subscriptions are changed through the customer portal when that option is available. Contact support if the change you need is not shown.' },
              { q: 'What happens when my trial ends?', a: 'At the end of your 14-day free trial, you will be prompted to choose a plan and add payment details. Your data is safe \u2014 nothing is deleted if you need a few extra days to decide.' },
              { q: 'Can I cancel any time?', a: 'Yes. You can cancel from your account settings at any time. If you cancel an annual plan, you will retain access until the end of your billing period.' },
            ].map(({ q, a }) => (
              <details key={q} className="group border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden">
                <summary className="flex items-center justify-between cursor-pointer px-6 py-5 text-lg font-semibold text-gray-950 dark:text-white hover:bg-gray-50 dark:hover:bg-gray-900 transition-colors list-none">
                  {q}
                  <ChevronDown className="w-5 h-5 text-gray-400 dark:text-gray-400 transition-transform group-open:rotate-180 flex-shrink-0 ml-3" aria-hidden="true" />
                </summary>
                <p className="px-6 pb-5 text-gray-700 dark:text-gray-300 leading-relaxed">{a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-20 bg-teal-primary">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h2 className="text-3xl font-bold text-white mb-4">
            Start your free trial today
          </h2>
          <p className="text-teal-100 text-lg mb-8">
            14 days. No credit card. Full access to your chosen plan.
          </p>
          <Button
            as={Link}
            href="/register"
            size="lg"
            className="bg-amber-accent text-gray-900 font-bold text-base px-10 hover:bg-amber-light"
            radius="lg"
          >
            Start your 14-day free trial
          </Button>
        </div>
      </section>

    </div>
  );
}
