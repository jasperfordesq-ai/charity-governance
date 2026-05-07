import { Button, Card, CardBody, Link } from '@/components/heroui-client';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Features — CharityPilot',
  description:
    'Explore all the features that make CharityPilot the best governance compliance tool for Irish charities.',
};

const features = [
  {
    id: 'compliance-tracker',
    title: 'Compliance Tracker',
    tagline: 'See exactly where you stand',
    description:
      'The Compliance Tracker is the heart of CharityPilot. It maps your charity against every applicable standard of the CRA Charities Governance Code and gives you a clear, real-time picture of your compliance status.',
    details: [
      'Interactive dashboard showing compliance percentage across all 6 principles',
      'Drill down into each principle to view individual standards',
      'Mark standards as Not Started, Working Towards, Compliant, Explain, or Not Applicable',
      'Capture the action taken, evidence, status, and explanation fields needed for the annual Compliance Record Form',
      'Add notes for your board to review before annual sign-off',
      'Automatic detection of whether your charity needs the 32 core or all 49 standards',
    ],
    colour: 'bg-teal-primary',
    icon: (
      <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
  {
    id: 'document-vault',
    title: 'Document Vault',
    tagline: 'One secure place for everything',
    description:
      'Stop searching through email threads, shared drives, and filing cabinets. The Document Vault gives you a single, organised, searchable home for every governance document your charity needs.',
    details: [
      'Upload and organise policies, minutes, constitutions, and evidence',
      'Tag documents to specific Governance Code standards',
      'Record document owner, approval date, review date, and board minute reference',
      'Track evidence pack readiness across the documents trustees normally need',
      'Store common formats including PDF, Office files, images, text, and CSV',
      'Keep evidence organised for board review, funder queries, and annual reporting',
    ],
    colour: 'bg-teal-dark',
    icon: (
      <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
      </svg>
    ),
  },
  {
    id: 'board-register',
    title: 'Board Register',
    tagline: 'Know your board, demonstrate governance',
    description:
      'A well-managed board register is a cornerstone of good governance. CharityPilot makes it easy to maintain an up-to-date register that demonstrates compliance with Principles 3 (Leading People) and 5 (Working Effectively).',
    details: [
      'Record all current and past board members in one place',
      'Track appointment and retirement dates, and term limits',
      'Track trustee induction and signed code of conduct status',
      'Connect trustee names to conflict of interest records',
      'Automatic alerts when a term limit is approaching or exceeded',
      'Feed trustee readiness signals into the dashboard and compliance report',
    ],
    colour: 'bg-teal-light',
    icon: (
      <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z" />
      </svg>
    ),
  },
  {
    id: 'deadline-tracker',
    title: 'Deadline Tracker',
    tagline: 'Never miss a filing date again',
    description:
      'Charity governance involves a relentless cycle of deadlines -- annual returns, CRO filings, policy reviews, board meetings. The Deadline Tracker keeps everything visible and sends reminders before it is too late.',
    details: [
      'Pre-populated with standard Irish charity deadlines (CRA, CRO, Revenue)',
      'Add custom deadlines for board meetings, policy reviews, and more',
      'Email reminders sent 30, 14, and 7 days before each deadline',
      'Reminder delivery is logged so the team can verify whether an email was sent or failed',
      'Annual Report deadlines are generated from the organisation financial year end',
      'Mark deadlines as complete and track your on-time filing history',
    ],
    colour: 'bg-amber-accent',
    icon: (
      <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
      </svg>
    ),
  },
  {
    id: 'pdf-export',
    title: 'Compliance Report',
    tagline: 'Professional reports at the click of a button',
    description:
      'When the board meets, the auditor calls, or a funder asks for proof of governance, you need a polished report fast. CharityPilot generates a printable compliance report from your live data.',
    details: [
      'One-click generation of printable compliance reports',
      'Principle-by-principle breakdown with status indicators',
      'Evidence summaries for each standard in the report',
      'Board approval/sign-off section with minute reference',
      'Date-stamped for audit trail purposes',
      'Includes governance registers, Annual Report readiness, and financial controls',
    ],
    colour: 'bg-teal-primary',
    icon: (
      <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
      </svg>
    ),
  },
];

export default function FeaturesPage() {
  return (
    <div className="min-h-screen">
      {/* Hero */}
      <section className="py-16 md:py-24 bg-gradient-to-b from-gray-50 to-white">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h1 className="text-4xl md:text-5xl font-extrabold text-gray-900 tracking-tight">
            Features built for
            <span className="text-teal-primary"> Irish charities</span>
          </h1>
          <p className="mt-4 text-lg text-gray-600 max-w-2xl mx-auto leading-relaxed">
            Every feature in CharityPilot is designed around the CRA Charities Governance Code.
            No generic project management -- just the tools you actually need to stay compliant.
          </p>
        </div>
      </section>

      {/* Feature Deep Dives */}
      <section className="pb-20">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 space-y-24">
          {features.map((feature, index) => (
            <div
              key={feature.id}
              id={feature.id}
              className={`flex flex-col ${
                index % 2 === 0 ? 'lg:flex-row' : 'lg:flex-row-reverse'
              } gap-12 items-center`}
            >
              {/* Content */}
              <div className="flex-1">
                <div
                  className={`inline-flex items-center justify-center w-14 h-14 rounded-2xl ${feature.colour} text-white mb-6`}
                >
                  {feature.icon}
                </div>
                <h2 className="text-3xl font-bold text-gray-900 mb-2">{feature.title}</h2>
                <p className="text-lg text-amber-accent font-medium mb-4">{feature.tagline}</p>
                <p className="text-gray-600 leading-relaxed mb-8">{feature.description}</p>
                <ul className="space-y-3">
                  {feature.details.map((detail) => (
                    <li key={detail} className="flex items-start gap-3 text-sm text-gray-700">
                      <svg
                        className="w-5 h-5 text-teal-primary flex-shrink-0 mt-0.5"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                      </svg>
                      <span>{detail}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Feature preview */}
              <div className="flex-1 w-full">
                <Card className="border border-gray-100 shadow-sm overflow-hidden">
                  <CardBody className="p-0">
                    <div
                      className={`${feature.colour} bg-opacity-10 h-64 lg:h-80 flex items-center justify-center`}
                    >
                      <div className="text-center">
                        <div className={`inline-flex items-center justify-center w-20 h-20 rounded-2xl ${feature.colour} text-white mb-4 opacity-80`}>
                          {feature.icon}
                        </div>
                        <p className="text-sm text-gray-500 font-medium">{feature.title} preview</p>
                      </div>
                    </div>
                  </CardBody>
                </Card>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Additional Capabilities */}
      <section className="py-20 bg-gray-50">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <h2 className="text-2xl md:text-3xl font-bold text-gray-900 text-center mb-12">
            And everything else you need
          </h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {[
              { title: 'Role-based access', text: 'Invite owners, admins, and members into one charity workspace.' },
              { title: 'Board sign-off', text: 'Record the annual board review position, minute reference, approver, and approval notes.' },
              {
                title: 'Secure by design',
                text: 'Production setup supports real Stripe billing, verified reminder emails, and structured evidence storage.',
              },
              {
                title: 'Mobile-friendly',
                text: 'Access your governance dashboard from phone, tablet, or desktop.',
              },
              {
                title: 'Irish-first',
                text: 'Built specifically for the CRA Charities Governance Code. No generic compliance tools.',
              },
              {
                title: 'Affordable',
                text: 'Priced for charity budgets, not enterprise IT departments. Starting at just EUR 19/month.',
              },
            ].map((item) => (
              <Card key={item.title} className="border border-gray-100 shadow-sm bg-white">
                <CardBody className="p-6">
                  <h3 className="text-base font-semibold text-gray-900 mb-2">{item.title}</h3>
                  <p className="text-sm text-gray-600 leading-relaxed">{item.text}</p>
                </CardBody>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-20 bg-teal-primary">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h2 className="text-3xl font-bold text-white mb-4">
            See it in action
          </h2>
          <p className="text-teal-100 text-lg mb-8 leading-relaxed">
            Start your 14-day free trial today. No credit card required -- explore every feature
            with your real data.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Button
              as={Link}
              href="/register"
              size="lg"
              className="bg-amber-accent text-gray-900 font-bold text-base px-10 hover:bg-amber-light"
              radius="full"
            >
              Start your free trial
            </Button>
            <Button
              as={Link}
              href="/pricing"
              size="lg"
              variant="bordered"
              className="border-white/30 text-white font-semibold text-base px-10 hover:bg-white/10"
              radius="full"
            >
              View pricing
            </Button>
          </div>
        </div>
      </section>

    </div>
  );
}
