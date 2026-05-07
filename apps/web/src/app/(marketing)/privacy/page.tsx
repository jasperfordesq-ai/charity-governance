import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Privacy Policy — CharityPilot',
  description:
    'Privacy Policy for CharityPilot.ie. Learn how Project Nexus Ltd collects, uses, and protects your personal data in compliance with GDPR.',
};

export default function PrivacyPage() {
  return (
    <div className="bg-white py-16 md:py-24">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="mb-12">
          <p className="text-sm font-semibold text-teal-primary uppercase tracking-wider mb-3">
            Legal
          </p>
          <h1 className="text-4xl font-bold text-gray-900 mb-4">Privacy Policy</h1>
          <p className="text-gray-500 text-sm">Effective date: 1 April 2026</p>
        </div>

        <div className="prose prose-gray max-w-none prose-headings:font-bold prose-headings:text-gray-900 prose-p:text-gray-600 prose-p:leading-relaxed prose-a:text-teal-primary prose-a:no-underline hover:prose-a:underline prose-li:text-gray-600">

          <p>
            This Privacy Policy describes how <strong>Project Nexus Ltd</strong> (&ldquo;we&rdquo;,
            &ldquo;us&rdquo;, or &ldquo;our&rdquo;) collects, uses, and protects personal data when
            you use <strong>CharityPilot.ie</strong> (the &ldquo;Service&rdquo;). We are committed to
            protecting your privacy and complying with the General Data Protection Regulation (GDPR)
            and the Data Protection Acts 1988&ndash;2018.
          </p>

          <h2>1. Data Controller</h2>
          <p>
            The data controller for personal data processed through CharityPilot.ie is:
          </p>
          <address className="not-italic bg-gray-50 rounded-xl p-5 border border-gray-100 my-4 text-gray-600 text-sm leading-relaxed">
            <strong className="text-gray-900">Project Nexus Ltd</strong><br />
            Skibbereen<br />
            Co. Cork<br />
            Ireland<br />
            <a href="mailto:privacy@charitypilot.ie" className="text-teal-primary">
              privacy@charitypilot.ie
            </a>
          </address>

          <h2>2. What Personal Data We Collect</h2>
          <p>We collect the following categories of personal data:</p>
          <ul>
            <li>
              <strong>Account data:</strong> your name, email address, and password (stored in
              hashed form) when you register for an account.
            </li>
            <li>
              <strong>Organisation data:</strong> your charity&apos;s name, Registered Charity
              Number (RCN), address, and classification details (simple or complex) that you
              provide when setting up your charity profile.
            </li>
            <li>
              <strong>Compliance data:</strong> governance standards assessments, evidence notes,
              document metadata, board member records, and deadline information that you enter into
              the Service.
            </li>
            <li>
              <strong>Billing data:</strong> your payment method details are processed directly by
              our payment provider (Stripe). We store only the last four digits of your card,
              billing name, and subscription status — we never store full card numbers.
            </li>
            <li>
              <strong>Usage data:</strong> log files, IP addresses, browser type, and pages
              visited, collected automatically when you use the Service.
            </li>
            <li>
              <strong>Communications:</strong> the content of any emails or support messages you
              send to us.
            </li>
          </ul>

          <h2>3. How We Use Your Personal Data</h2>
          <p>We use your personal data for the following purposes:</p>
          <ul>
            <li>To create and manage your account and provide access to the Service.</li>
            <li>
              To process subscription payments and manage your billing relationship with us.
            </li>
            <li>
              To send you transactional emails such as password reset links, payment receipts,
              and deadline reminders.
            </li>
            <li>
              To send you occasional product updates and governance news relevant to Irish
              charities (you may unsubscribe at any time).
            </li>
            <li>
              To detect, investigate, and prevent fraudulent activity and abuse of the Service.
            </li>
            <li>
              To improve the Service by analysing aggregated, anonymised usage patterns.
            </li>
            <li>To comply with our legal obligations under Irish and EU law.</li>
          </ul>

          <h2>4. Legal Basis for Processing</h2>
          <p>We rely on the following legal bases under Article 6 GDPR:</p>
          <ul>
            <li>
              <strong>Performance of a contract (Art. 6(1)(b)):</strong> processing your account,
              organisation, and compliance data is necessary to provide the Service you have
              subscribed to.
            </li>
            <li>
              <strong>Legitimate interests (Art. 6(1)(f)):</strong> processing usage data and
              sending product-related communications is in our legitimate interest in operating,
              improving, and promoting the Service, provided this does not override your rights.
            </li>
            <li>
              <strong>Legal obligation (Art. 6(1)(c)):</strong> retaining certain billing and
              transaction records as required by Irish tax and company law.
            </li>
            <li>
              <strong>Consent (Art. 6(1)(a)):</strong> for optional analytics cookies, where we
              will ask for your consent separately via our cookie banner.
            </li>
          </ul>

          <h2>5. Data Retention</h2>
          <p>
            We retain your personal data for as long as your account is active or as necessary to
            provide the Service. Upon account closure:
          </p>
          <ul>
            <li>
              Your account data, organisation profile, compliance data, and documents will be
              permanently deleted within 30 days of account closure.
            </li>
            <li>
              Billing and transaction records will be retained for 7 years to comply with Irish
              Revenue requirements.
            </li>
            <li>
              Anonymised, aggregated usage statistics (which cannot identify you) may be retained
              indefinitely.
            </li>
          </ul>

          <h2>6. Your Rights Under GDPR</h2>
          <p>
            As a data subject under GDPR, you have the following rights, which you can exercise
            by contacting us at{' '}
            <a href="mailto:privacy@charitypilot.ie">privacy@charitypilot.ie</a>:
          </p>
          <ul>
            <li>
              <strong>Right of access (Art. 15):</strong> to request a copy of the personal data
              we hold about you.
            </li>
            <li>
              <strong>Right to rectification (Art. 16):</strong> to request that inaccurate or
              incomplete data be corrected.
            </li>
            <li>
              <strong>Right to erasure (Art. 17):</strong> to request deletion of your personal
              data (&ldquo;right to be forgotten&rdquo;), subject to our legal retention
              obligations.
            </li>
            <li>
              <strong>Right to data portability (Art. 20):</strong> to receive your data in a
              structured, machine-readable format where technically feasible. You may export your
              compliance position as a printable report from within your account at any time.
            </li>
            <li>
              <strong>Right to restrict processing (Art. 18):</strong> to request that we limit
              how we use your data in certain circumstances.
            </li>
            <li>
              <strong>Right to object (Art. 21):</strong> to object to processing based on
              legitimate interests, including direct marketing.
            </li>
            <li>
              <strong>Right to withdraw consent (Art. 7(3)):</strong> where processing is based
              on consent, you may withdraw it at any time without affecting the lawfulness of
              prior processing.
            </li>
          </ul>
          <p>
            You also have the right to lodge a complaint with the{' '}
            <a
              href="https://www.dataprotection.ie"
              target="_blank"
              rel="noopener noreferrer"
            >
              Data Protection Commission (DPC)
            </a>{' '}
            of Ireland if you believe your rights under GDPR have been infringed.
          </p>

          <h2>7. Third-Party Processors</h2>
          <p>
            We share personal data with the following sub-processors who assist us in delivering
            the Service. Each is bound by a data processing agreement and complies with GDPR:
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse border border-gray-200 rounded-xl overflow-hidden my-4">
              <thead>
                <tr className="bg-gray-50">
                  <th className="text-left p-3 border border-gray-200 font-semibold text-gray-900">Processor</th>
                  <th className="text-left p-3 border border-gray-200 font-semibold text-gray-900">Purpose</th>
                  <th className="text-left p-3 border border-gray-200 font-semibold text-gray-900">Location</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="p-3 border border-gray-200 text-gray-600">Stripe</td>
                  <td className="p-3 border border-gray-200 text-gray-600">Payment processing and subscription billing</td>
                  <td className="p-3 border border-gray-200 text-gray-600">USA/EU (SCCs in place)</td>
                </tr>
                <tr className="bg-gray-50">
                  <td className="p-3 border border-gray-200 text-gray-600">Supabase</td>
                  <td className="p-3 border border-gray-200 text-gray-600">Database hosting and authentication</td>
                  <td className="p-3 border border-gray-200 text-gray-600">EU (Ireland)</td>
                </tr>
                <tr>
                  <td className="p-3 border border-gray-200 text-gray-600">Resend</td>
                  <td className="p-3 border border-gray-200 text-gray-600">Transactional email delivery</td>
                  <td className="p-3 border border-gray-200 text-gray-600">USA (SCCs in place)</td>
                </tr>
                <tr className="bg-gray-50">
                  <td className="p-3 border border-gray-200 text-gray-600">Vercel</td>
                  <td className="p-3 border border-gray-200 text-gray-600">Application hosting and CDN</td>
                  <td className="p-3 border border-gray-200 text-gray-600">EU/USA (SCCs in place)</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p>
            We do not sell your personal data to third parties, and we do not use it for
            advertising purposes.
          </p>

          <h2>8. Cookies</h2>
          <p>
            We use cookies and similar technologies on our website. Essential cookies are required
            for the Service to function. We will request your consent before placing any
            non-essential (analytics or preference) cookies via our cookie banner. You can change
            your cookie preferences at any time.
          </p>

          <h2>9. Security</h2>
          <p>
            We implement appropriate technical and organisational measures to protect your personal
            data against unauthorised access, loss, or disclosure. These include TLS encryption
            in transit, encryption at rest in our database, and role-based access controls.
            However, no transmission over the internet is entirely secure, and we cannot guarantee
            absolute security.
          </p>

          <h2>10. Changes to This Policy</h2>
          <p>
            We may update this Privacy Policy from time to time. When we do, we will update the
            effective date at the top of this page and, where the changes are material, notify
            you by email. Your continued use of the Service after any change constitutes acceptance
            of the updated policy.
          </p>

          <h2>11. Contact Us</h2>
          <p>
            For any questions, requests, or complaints relating to this Privacy Policy or our
            data processing practices, please contact our data protection point of contact:
          </p>
          <p>
            <a href="mailto:privacy@charitypilot.ie">privacy@charitypilot.ie</a>
            <br />
            Project Nexus Ltd, Skibbereen, Co. Cork, Ireland
          </p>
        </div>
      </div>
    </div>
  );
}
