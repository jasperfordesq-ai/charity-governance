import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Privacy Policy - CharityPilot',
  description:
    'How CharityPilot handles account, governance, billing, document, and technical data.',
};

export default function PrivacyPage() {
  return (
    <div className="bg-white py-16 text-gray-950 dark:bg-gray-950 dark:text-gray-50 md:py-24">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="mb-12">
          <p className="text-sm font-semibold text-teal-primary uppercase tracking-wider mb-3">
            Legal
          </p>
          <h1 className="text-4xl font-bold text-gray-950 dark:text-white mb-4">Privacy Policy</h1>
          <p className="text-gray-600 dark:text-gray-300 text-sm">
            Pre-launch draft - not approved for production
          </p>
        </div>

        <div className="prose prose-gray max-w-none dark:prose-invert prose-headings:font-bold prose-headings:text-gray-950 dark:prose-headings:text-white prose-p:text-gray-700 dark:prose-p:text-gray-300 prose-p:leading-relaxed prose-a:text-teal-primary dark:prose-a:text-teal-bright prose-a:no-underline hover:prose-a:underline prose-li:text-gray-700 dark:prose-li:text-gray-300 dark:prose-strong:text-white">
          <div className="not-prose mb-8 rounded-lg border border-amber-300 bg-amber-50 p-5 text-sm leading-relaxed text-amber-950 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100">
            <strong>Pre-launch privacy status.</strong> CharityPilot is in early development. This
            notice describes the current repository implementation. The production controller,
            contact channels, providers and processing regions, transfer safeguards, retention
            schedule, rights-request process, policy version, and effective date require accountable
            legal and privacy approval before production launch.
          </div>

          <p>
            This pre-launch notice describes the personal data processed by CharityPilot while the
            Service is being prepared for production. It records current product behavior without
            claiming that outstanding legal, provider, or operational decisions have been completed.
          </p>

          <h2>1. Production Data Controller</h2>
          <p>
            The final production data controller has not yet been formally approved. Its legal name,
            registered contact details, privacy contact, and controller responsibilities must be
            verified and published before production use.
          </p>

          <h2>2. What Personal Data CharityPilot Processes</h2>
          <p>The current application processes the following categories of personal data:</p>
          <ul>
            <li>
              <strong>Account and team data:</strong> names, email addresses, password hashes,
              roles, verification and membership status, team-invitation details, session/device
              information, and security-audit records.
            </li>
            <li>
              <strong>Organisation data:</strong> the charity&apos;s name, Registered Charity Number
              (RCN), address, contact details, legal form, classification, registration dates, and
              conditional governance profile information entered by authorised users.
            </li>
            <li>
              <strong>Governance and compliance data:</strong> standards assessments, evidence
              notes, sign-offs and approval snapshots, governance-register entries, deadlines,
              board-member records, document metadata, and the contents of files the organisation
              uploads.
            </li>
            <li>
              <strong>Billing data:</strong> payment-method and billing details are collected and
              processed by Stripe on Stripe-hosted pages. CharityPilot stores Stripe customer,
              subscription, and Checkout Session identifiers together with the selected plan,
              billing interval, subscription status, cancellation state, and relevant billing dates.
              CharityPilot&apos;s application database does not store card numbers, card last-four
              values, or billing names.
            </li>
            <li>
              <strong>Transactional email data:</strong> recipient names and email addresses plus
              the content needed for welcome, email-verification, password-reset, team-invitation,
              and deadline-reminder messages sent through Resend.
            </li>
            <li>
              <strong>Technical and security data:</strong> API requests can generate operational
              and security logs containing timestamps, request methods and paths, response status,
              request identifiers, network-address data, and technical error information. These
              records support rate limiting, security, diagnostics, and incident response. The
              current web application does not include a page-view analytics integration.
            </li>
          </ul>

          <h2>3. Current Processing Purposes</h2>
          <p>The current application uses personal data for the following implemented purposes:</p>
          <ul>
            <li>To create and secure accounts and provide access to the Service.</li>
            <li>To maintain organisation, governance, compliance, document, and deadline records.</li>
            <li>To administer subscriptions through Stripe.</li>
            <li>
              To send transactional welcome, email-verification, password-reset, team-invitation,
              and deadline-reminder emails through Resend.
            </li>
            <li>To enforce tenant access, role permissions, rate limits, and session security.</li>
            <li>To diagnose failures and respond to security or operational incidents.</li>
          </ul>
          <p>
            The repository does not currently implement marketing-email campaigns or page-view
            analytics. Any future purpose must be assessed, approved, and reflected in this notice
            before it is enabled in production.
          </p>

          <h2>4. Legal Bases</h2>
          <p>
            Production legal bases have not yet been approved. Before launch, accountable legal and
            privacy review must map every processing purpose to an appropriate legal basis, document
            any legitimate-interest assessment or consent requirement, and align the approved notice
            with the implemented product and provider configuration.
          </p>

          <h2>5. Data Retention and Account Closure</h2>
          <p>
            CharityPilot does not yet have an approved production retention schedule or a complete
            account-closure deletion workflow. The current application therefore does not guarantee
            deletion within 30 days, enforce a seven-year billing-record period, or create anonymised
            page-analytics records for indefinite retention.
          </p>
          <p>
            Before production launch, an approved schedule and implemented workflow must cover
            application records, uploaded document objects, provider records, technical logs,
            security and audit history, backups, legal holds, account closure, and data-rights
            requests.
          </p>

          <h2>6. Data-Protection Rights</h2>
          <p>
            Applicable data-protection rights may include access, rectification, erasure, restriction,
            objection, portability, and withdrawal of consent where processing relies on consent.
            Before production launch, CharityPilot must have an approved request-handling process,
            identity-verification controls, and a verified contact channel for exercising those
            rights.
          </p>
          <p>
            The in-product compliance report is a governance report. It is not a complete export of
            all personal data held about an individual or a complete Article 20 portability response.
          </p>
          <p>
            Individuals also have the right to lodge a complaint with the{' '}
            <a
              href="https://www.dataprotection.ie"
              target="_blank"
              rel="noopener noreferrer"
            >
              Data Protection Commission (DPC)
            </a>{' '}
            of Ireland. The wording and operation of the production rights process remain subject to
            accountable legal and privacy approval.
          </p>

          <h2>7. Third-Party Services and Production Status</h2>
          <p>
            CharityPilot stores application records in PostgreSQL through Prisma and implements its
            own authentication using password hashes, signed access tokens, and hashed rotating
            refresh sessions. The current Supabase integration is used only for private document
            object storage; Supabase Auth is not used. The production PostgreSQL provider has not yet
            been selected or configured.
          </p>
          <p>
            The repository integrates with the services below. Listing an integration does not claim
            that a production account, data processing agreement, processing region, or international-
            transfer safeguard has been verified. Those records must be approved before production
            launch.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden my-4">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-900">
                  <th className="text-left p-3 border border-gray-200 dark:border-gray-800 font-semibold text-gray-950 dark:text-white">Service</th>
                  <th className="text-left p-3 border border-gray-200 dark:border-gray-800 font-semibold text-gray-950 dark:text-white">Current purpose</th>
                  <th className="text-left p-3 border border-gray-200 dark:border-gray-800 font-semibold text-gray-950 dark:text-white">Production status</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="p-3 border border-gray-200 dark:border-gray-800 text-gray-700 dark:text-gray-300">Stripe</td>
                  <td className="p-3 border border-gray-200 dark:border-gray-800 text-gray-700 dark:text-gray-300">Hosted checkout, customer/subscription administration, and billing portal</td>
                  <td className="p-3 border border-gray-200 dark:border-gray-800 text-gray-700 dark:text-gray-300">Integration implemented; production account, agreement, processing locations, and transfer safeguards are not yet verified</td>
                </tr>
                <tr className="bg-gray-50 dark:bg-gray-900">
                  <td className="p-3 border border-gray-200 dark:border-gray-800 text-gray-700 dark:text-gray-300">Supabase</td>
                  <td className="p-3 border border-gray-200 dark:border-gray-800 text-gray-700 dark:text-gray-300">Private document object storage only</td>
                  <td className="p-3 border border-gray-200 dark:border-gray-800 text-gray-700 dark:text-gray-300">Integration implemented; production project, agreement, processing region, and transfer safeguards are not yet verified</td>
                </tr>
                <tr>
                  <td className="p-3 border border-gray-200 dark:border-gray-800 text-gray-700 dark:text-gray-300">Resend</td>
                  <td className="p-3 border border-gray-200 dark:border-gray-800 text-gray-700 dark:text-gray-300">Transactional email delivery</td>
                  <td className="p-3 border border-gray-200 dark:border-gray-800 text-gray-700 dark:text-gray-300">Integration implemented; production account/domain, agreement, processing locations, and transfer safeguards are not yet verified</td>
                </tr>
                <tr className="bg-gray-50 dark:bg-gray-900">
                  <td className="p-3 border border-gray-200 dark:border-gray-800 text-gray-700 dark:text-gray-300">PostgreSQL and application hosting</td>
                  <td className="p-3 border border-gray-200 dark:border-gray-800 text-gray-700 dark:text-gray-300">Application database and API/web hosting</td>
                  <td className="p-3 border border-gray-200 dark:border-gray-800 text-gray-700 dark:text-gray-300">Production providers and processing regions are not yet selected or configured</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p>
            CharityPilot does not sell personal data or use it for advertising in the current
            application. These statements must be reconfirmed as part of production privacy review.
          </p>

          <h2>8. Cookies and Local Preferences</h2>
          <p>
            CharityPilot currently uses only strictly necessary, HTTP-only authentication cookies to
            maintain and secure signed-in sessions. The current application does not set analytics or
            advertising cookies. The existing cookie notice records a local preference only and does
            not control a tracking technology.
          </p>
          <p>
            Whether to retain an informational notice or introduce non-essential consent tooling is
            an outstanding product and privacy decision. If non-essential cookies are introduced,
            they must remain disabled until an approved consent-and-withdrawal mechanism and updated
            notice are in place.
          </p>

          <h2>9. Security</h2>
          <p>
            The application code hashes passwords and stored refresh tokens, uses HTTP-only cookies,
            enforces tenant and role checks, and requires HTTPS origins in production configuration.
            Database and object-storage encryption at rest, hosting controls, logging retention,
            backup security, and other provider controls must be verified against the selected
            production services before launch. No internet service can guarantee absolute security.
          </p>

          <h2>10. Changes to This Notice</h2>
          <p>
            The production policy version, effective date, material-change notification method, and
            any acknowledgement requirements have not yet been approved. This draft will be updated
            when those decisions and the corresponding operational process are complete.
          </p>

          <h2>11. Privacy Contact</h2>
          <p>
            No production privacy contact channel has yet been verified. A published and monitored
            privacy and data-rights contact, together with request-handling evidence, must be in place
            before production launch.
          </p>
        </div>
      </div>
    </div>
  );
}
