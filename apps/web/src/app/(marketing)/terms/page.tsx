import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Terms of Service — CharityPilot',
  description:
    'Terms of Service for CharityPilot.ie. Subscription terms, acceptable use, data ownership, and governing law.',
};

export default function TermsPage() {
  return (
    <div className="bg-white py-16 text-gray-950 dark:bg-gray-950 dark:text-gray-50 md:py-24">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="mb-12">
          <p className="text-sm font-semibold text-teal-primary uppercase tracking-wider mb-3">
            Legal
          </p>
          <h1 className="text-4xl font-bold text-gray-950 dark:text-white mb-4">Terms of Service</h1>
          <p className="text-gray-600 dark:text-gray-300 text-sm">Effective date: 1 April 2026</p>
        </div>

        <div className="prose prose-gray max-w-none dark:prose-invert prose-headings:font-bold prose-headings:text-gray-950 dark:prose-headings:text-white prose-p:text-gray-700 dark:prose-p:text-gray-300 prose-p:leading-relaxed prose-a:text-teal-primary dark:prose-a:text-teal-bright prose-a:no-underline hover:prose-a:underline prose-li:text-gray-700 dark:prose-li:text-gray-300 dark:prose-strong:text-white">

          <p>
            Please read these Terms of Service (&ldquo;Terms&rdquo;) carefully before using
            CharityPilot.ie (the &ldquo;Service&rdquo;) operated by{' '}
            <strong>Project Nexus Ltd</strong>, a company registered in Ireland
            (&ldquo;we&rdquo;, &ldquo;us&rdquo;, or &ldquo;our&rdquo;). By creating an account
            or using the Service, you agree to be bound by these Terms.
          </p>

          <h2>1. Service Description</h2>
          <p>
            CharityPilot is a software-as-a-service (SaaS) platform designed to help Irish
            registered charities manage compliance with the Charities Regulatory Authority (CRA)
            Charities Governance Code. The Service enables organisations to:
          </p>
          <ul>
            <li>Track compliance against the 6 principles and up to 49 standards of the Charities Governance Code;</li>
            <li>Store and organise governance documents, policies, and evidence;</li>
            <li>Maintain a register of board members and their details;</li>
            <li>Track and receive reminders for governance deadlines and filing dates;</li>
            <li>Generate compliance reports for internal use and regulatory submissions.</li>
          </ul>
          <p>
            The Service is informational and administrative in nature. It does not constitute
            legal or regulatory advice. We strongly recommend that your organisation seeks
            independent legal or governance advice where necessary.
          </p>

          <h2>2. Eligibility</h2>
          <p>
            To use the Service you must be at least 18 years old and authorised to act on behalf
            of the organisation whose details you register. By creating an account, you warrant
            that the information you provide is accurate and that you have authority to bind your
            organisation to these Terms.
          </p>

          <h2>3. Subscription Plans and Billing</h2>

          <h3>3.1 Plans</h3>
          <p>We offer two subscription plans:</p>
          <ul>
            <li>
              <strong>Essentials:</strong> Designed for non-complex charities. Covers the 32 core
              standards applicable to non-complex organisations as defined by the CRA. Priced at
              &euro;19/month or &euro;190/year.
            </li>
            <li>
              <strong>Complete:</strong> Designed for charities that need the additional Governance
              Code standards because of their size, income, staffing, activities, structure, or risk
              profile. Covers all 49 standards. Priced at &euro;39/month or &euro;390/year.
            </li>
          </ul>

          <h3>3.2 Free Trial</h3>
          <p>
            All new accounts are eligible for a <strong>14-day free trial</strong> with full
            access to the Complete plan features. No credit card is required to start your trial.
            At the end of the trial period, you will be prompted to select a plan and enter
            payment details to continue using the Service. If you do not subscribe, your account
            will be suspended and your data retained for 30 days before deletion.
          </p>

          <h3>3.3 Billing</h3>
          <p>
            Subscriptions are billed in advance on a monthly or annual basis. Payments are
            processed by Stripe. By providing payment details, you authorise us to charge the
            applicable subscription fee at the start of each billing period. All prices are
            quoted exclusive of VAT. Where applicable, Irish VAT at the standard rate will be
            added to your invoice.
          </p>

          <h3>3.4 Cancellation and Refunds</h3>
          <p>
            You may cancel your subscription at any time from your account settings. On
            cancellation, you will retain access to the Service until the end of your current
            billing period; no refund is issued for the unused portion of a prepaid period.
            Annual subscribers who cancel within 14 days of renewal may request a pro-rated
            refund by contacting{' '}
            <a href="mailto:support@charitypilot.ie">support@charitypilot.ie</a>.
          </p>

          <h3>3.5 Price Changes</h3>
          <p>
            We reserve the right to change subscription prices. We will give you at least 30
            days&apos; written notice of any price increase, and the new price will take effect
            from your next renewal date. If you do not wish to accept the new price, you may
            cancel your subscription before the renewal date.
          </p>

          <h2>4. Acceptable Use</h2>
          <p>You agree to use the Service only for lawful purposes and in accordance with these Terms. You must not:</p>
          <ul>
            <li>Use the Service for any purpose that is unlawful, fraudulent, or deceptive;</li>
            <li>
              Upload, store, or transmit content that infringes any third-party intellectual
              property rights, is defamatory, or is otherwise unlawful;
            </li>
            <li>
              Attempt to gain unauthorised access to any part of the Service, other accounts,
              or computer systems connected to the Service;
            </li>
            <li>
              Use automated scripts, bots, or scrapers to access the Service without our prior
              written consent;
            </li>
            <li>
              Resell, sublicense, or otherwise commercialise the Service without our express
              written permission;
            </li>
            <li>
              Use the Service to store or process sensitive personal data (such as health data
              or financial account data of third parties) beyond what is strictly necessary for
              governance purposes.
            </li>
          </ul>
          <p>
            We reserve the right to suspend or terminate accounts that are in breach of this
            acceptable use policy.
          </p>

          <h2>5. Data Ownership</h2>
          <p>
            <strong>Your data belongs to you.</strong> All governance data, documents, board
            records, compliance assessments, and other content that you upload or create within
            the Service (&ldquo;Your Data&rdquo;) remains your property at all times. You grant
            us a limited licence to store, process, and display Your Data solely to the extent
            necessary to provide the Service to you.
          </p>
          <p>
            We will never sell Your Data to third parties or use it for advertising. We process
            Your Data only in accordance with our{' '}
            <a href="/privacy">Privacy Policy</a> and our obligations as a data processor under
            GDPR.
          </p>
          <p>
            You are responsible for ensuring that the personal data you enter into the Service
            (such as board member details) is collected and processed in compliance with GDPR
            and that your organisation has a lawful basis for doing so.
          </p>

          <h2>6. Intellectual Property</h2>
          <p>
            The Service, including its software, design, text, graphics, and branding, is owned
            by or licensed to Project Nexus Ltd and is protected by Irish and international
            intellectual property laws. Nothing in these Terms grants you any rights in the
            Service other than the right to use it in accordance with these Terms.
          </p>

          <h2>7. Service Availability and Changes</h2>
          <p>
            We aim to provide a reliable Service but cannot guarantee uninterrupted availability.
            We may perform scheduled maintenance from time to time and will endeavour to give
            advance notice where possible. We reserve the right to modify, update, or discontinue
            features of the Service with reasonable notice.
          </p>

          <h2>8. Limitation of Liability</h2>
          <p>
            To the fullest extent permitted by applicable law:
          </p>
          <ul>
            <li>
              The Service is provided &ldquo;as is&rdquo; without warranty of any kind, express
              or implied, including warranties of merchantability, fitness for a particular
              purpose, or non-infringement.
            </li>
            <li>
              We do not warrant that the Service is free from errors or that it will meet your
              specific requirements. You are responsible for verifying that your compliance
              activities satisfy your regulatory obligations.
            </li>
            <li>
              In no event shall Project Nexus Ltd be liable for any indirect, incidental, special,
              consequential, or punitive damages, including loss of profits, data, or goodwill,
              arising from your use of or inability to use the Service.
            </li>
            <li>
              Our total aggregate liability to you for any claim arising under or in connection
              with these Terms shall not exceed the total fees paid by you to us in the 12 months
              preceding the event giving rise to the claim.
            </li>
          </ul>
          <p>
            Nothing in these Terms excludes or limits our liability for death or personal injury
            caused by our negligence, or for fraud or fraudulent misrepresentation.
          </p>

          <h2>9. Indemnification</h2>
          <p>
            You agree to indemnify and hold harmless Project Nexus Ltd, its directors, employees,
            and agents from any claims, damages, losses, or expenses (including reasonable legal
            fees) arising from your use of the Service, your breach of these Terms, or your
            violation of any third-party rights.
          </p>

          <h2>10. Governing Law and Dispute Resolution</h2>
          <p>
            These Terms are governed by and construed in accordance with the laws of the{' '}
            <strong>Republic of Ireland</strong>. Any disputes arising from or in connection with
            these Terms shall be subject to the exclusive jurisdiction of the courts of Ireland.
          </p>
          <p>
            Before initiating formal legal proceedings, we encourage you to contact us at{' '}
            <a href="mailto:support@charitypilot.ie">support@charitypilot.ie</a> to seek an
            informal resolution.
          </p>

          <h2>11. Changes to These Terms</h2>
          <p>
            We may update these Terms from time to time. We will notify you of material changes
            by email and by posting a notice in the Service at least 14 days before the changes
            take effect. Your continued use of the Service after the effective date of the updated
            Terms constitutes your acceptance of them. If you do not agree to the changes, you
            must stop using the Service and cancel your subscription before the effective date.
          </p>

          <h2>12. Contact</h2>
          <p>
            If you have any questions about these Terms, please contact us at:
          </p>
          <address className="not-italic bg-gray-50 dark:bg-gray-900 rounded-lg p-5 border border-gray-200 dark:border-gray-800 my-4 text-gray-700 dark:text-gray-300 text-sm leading-relaxed">
            <strong className="text-gray-950 dark:text-white">Project Nexus Ltd</strong><br />
            Skibbereen<br />
            Co. Cork<br />
            Ireland<br />
            <a href="mailto:support@charitypilot.ie" className="text-teal-primary">
              support@charitypilot.ie
            </a>
          </address>

        </div>
      </div>
    </div>
  );
}
