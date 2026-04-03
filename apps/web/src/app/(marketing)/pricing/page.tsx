import { Button, Card, CardBody, CardHeader, Link } from '@heroui/react';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Pricing — CharityPilot',
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
      'PDF compliance reports',
      'Single organisation',
      'Up to 5 board member accounts',
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
      'Board Register with skill matrix',
      'Deadline Tracker with SMS + email reminders',
      'PDF compliance reports with evidence packs',
      'Single organisation',
      'Unlimited board member accounts',
      'Priority email support',
      'Annual compliance snapshot',
      'Custom branding on exports',
    ],
  },
];

const comparisonRows = [
  { feature: 'Governance Code standards', essentials: '32 core', complete: 'All 49' },
  { feature: 'Document storage', essentials: '2 GB', complete: '10 GB' },
  { feature: 'Board member accounts', essentials: 'Up to 5', complete: 'Unlimited' },
  { feature: 'Compliance Tracker', essentials: true, complete: true },
  { feature: 'Document Vault', essentials: true, complete: true },
  { feature: 'Board Register', essentials: true, complete: true },
  { feature: 'Skill matrix tracking', essentials: false, complete: true },
  { feature: 'Deadline Tracker', essentials: true, complete: true },
  { feature: 'Email reminders', essentials: true, complete: true },
  { feature: 'SMS reminders', essentials: false, complete: true },
  { feature: 'PDF export', essentials: true, complete: true },
  { feature: 'Evidence packs in export', essentials: false, complete: true },
  { feature: 'Custom branding on exports', essentials: false, complete: true },
  { feature: 'Annual compliance snapshot', essentials: false, complete: true },
  { feature: 'Support', essentials: 'Email', complete: 'Priority email' },
];

function CheckIcon() {
  return (
    <svg className="w-5 h-5 text-teal-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
    </svg>
  );
}

function CrossIcon() {
  return (
    <svg className="w-5 h-5 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}

function renderCell(value: boolean | string) {
  if (typeof value === 'boolean') {
    return value ? <CheckIcon /> : <CrossIcon />;
  }
  return <span className="text-sm text-gray-700">{value}</span>;
}

export default function PricingPage() {
  return (
    <div className="min-h-screen">
      {/* Navigation */}
      <nav className="sticky top-0 z-50 bg-white/90 backdrop-blur-md border-b border-gray-100">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <Link href="/" className="text-2xl font-bold text-teal-primary">
              CharityPilot
            </Link>
            <div className="hidden md:flex items-center gap-8">
              <Link href="/features" className="text-gray-600 hover:text-teal-primary transition-colors text-sm font-medium">
                Features
              </Link>
              <Link href="/pricing" className="text-teal-primary text-sm font-semibold">
                Pricing
              </Link>
              <Link href="/login" className="text-gray-600 hover:text-teal-primary transition-colors text-sm font-medium">
                Sign in
              </Link>
              <Button as={Link} href="/register" className="bg-teal-primary text-white font-semibold" radius="full" size="sm">
                Start Free Trial
              </Button>
            </div>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="py-16 md:py-24 bg-gradient-to-b from-gray-50 to-white">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h1 className="text-4xl md:text-5xl font-extrabold text-gray-900 tracking-tight">
            Simple, honest pricing
          </h1>
          <p className="mt-4 text-lg text-gray-600 max-w-2xl mx-auto leading-relaxed">
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
                className={`relative overflow-visible ${
                  plan.highlight
                    ? 'border-2 border-teal-primary shadow-lg'
                    : 'border-2 border-gray-200 shadow-sm'
                }`}
              >
                {plan.highlight && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-amber-accent text-gray-900 text-xs font-bold px-4 py-1 rounded-full">
                    Most Popular
                  </div>
                )}
                <CardHeader className="flex flex-col items-center pt-10 pb-4 px-8">
                  <p className="text-sm font-semibold text-teal-primary uppercase tracking-wider">
                    {plan.name}
                  </p>
                  <p className="text-xs text-gray-500 mt-1">{plan.audience}</p>
                  <div className="mt-4">
                    <span className="text-5xl font-bold text-gray-900">&euro;{plan.monthlyPrice}</span>
                    <span className="text-lg text-gray-500">/month</span>
                  </div>
                  <p className="text-sm text-gray-500 mt-1">
                    or &euro;{plan.annualPrice}/year{' '}
                    <span className="text-teal-primary font-medium">(save &euro;{plan.annualSaving})</span>
                  </p>
                </CardHeader>
                <CardBody className="px-8 pb-10">
                  <p className="text-gray-600 text-sm leading-relaxed mb-6 text-center">
                    {plan.description}
                  </p>
                  <Button
                    as={Link}
                    href="/register"
                    className={`w-full font-semibold ${
                      plan.highlight
                        ? 'bg-teal-primary text-white'
                        : 'bg-white border-2 border-teal-primary text-teal-primary hover:bg-teal-primary hover:text-white'
                    }`}
                    radius="full"
                    size="lg"
                  >
                    Start 14-day free trial
                  </Button>
                  <ul className="mt-8 space-y-3">
                    {plan.features.map((feature) => (
                      <li key={feature} className="flex items-start gap-3 text-sm text-gray-700">
                        <CheckIcon />
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
      <section className="py-20 bg-gray-50">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <h2 className="text-2xl md:text-3xl font-bold text-gray-900 text-center mb-12">
            Feature comparison
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b-2 border-gray-200">
                  <th className="text-left py-4 pr-4 text-sm font-semibold text-gray-900 w-1/2">
                    Feature
                  </th>
                  <th className="text-center py-4 px-4 text-sm font-semibold text-gray-900">
                    Essentials
                  </th>
                  <th className="text-center py-4 pl-4 text-sm font-semibold text-teal-primary">
                    Complete
                  </th>
                </tr>
              </thead>
              <tbody>
                {comparisonRows.map((row) => (
                  <tr key={row.feature} className="border-b border-gray-100">
                    <td className="py-4 pr-4 text-sm text-gray-700">{row.feature}</td>
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
      <section className="py-20 bg-white">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
          <h2 className="text-2xl md:text-3xl font-bold text-gray-900 text-center mb-12">
            Pricing questions
          </h2>
          <div className="space-y-8">
            <div className="border-b border-gray-100 pb-8">
              <h3 className="text-lg font-semibold text-gray-900 mb-2">
                How do I know if my charity is &ldquo;complex&rdquo;?
              </h3>
              <p className="text-gray-600 leading-relaxed">
                The CRA defines a complex charity as one with annual income over EUR 100,000, paid
                employees, or operations in more than one jurisdiction. If any of these apply, you
                should choose the Complete plan.
              </p>
            </div>
            <div className="border-b border-gray-100 pb-8">
              <h3 className="text-lg font-semibold text-gray-900 mb-2">
                Can I switch plans later?
              </h3>
              <p className="text-gray-600 leading-relaxed">
                Absolutely. You can upgrade from Essentials to Complete at any time. If you upgrade
                mid-billing cycle, we will pro-rate the difference.
              </p>
            </div>
            <div className="border-b border-gray-100 pb-8">
              <h3 className="text-lg font-semibold text-gray-900 mb-2">
                What happens when my trial ends?
              </h3>
              <p className="text-gray-600 leading-relaxed">
                At the end of your 14-day free trial, you will be prompted to choose a plan and add
                payment details. Your data is safe -- nothing is deleted if you need a few extra
                days to decide.
              </p>
            </div>
            <div className="pb-8">
              <h3 className="text-lg font-semibold text-gray-900 mb-2">
                Can I cancel any time?
              </h3>
              <p className="text-gray-600 leading-relaxed">
                Yes. You can cancel from your account settings at any time. If you cancel an annual
                plan, you will retain access until the end of your billing period.
              </p>
            </div>
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
            radius="full"
          >
            Start your 14-day free trial
          </Button>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-gray-900 text-gray-400 py-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col md:flex-row justify-between items-center gap-4">
            <p className="text-sm">&copy; {new Date().getFullYear()} Project Nexus Ltd. All rights reserved.</p>
            <div className="flex gap-6 text-sm">
              <Link href="/privacy" className="hover:text-white transition-colors text-gray-400">Privacy</Link>
              <Link href="/terms" className="hover:text-white transition-colors text-gray-400">Terms</Link>
              <Link href="/features" className="hover:text-white transition-colors text-gray-400">Features</Link>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
