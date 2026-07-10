import type { PostMeta } from '@/lib/blog';
import { CheckCircle2, ExternalLink, TriangleAlert } from 'lucide-react';

export const meta: PostMeta = {
  slug: 'annual-reporting-guide-irish-charities',
  title: 'Annual Reporting to the Charities Regulator: A Source-Checked Trustee Guide',
  excerpt:
    'A practical guide to the annual-report deadline, preparation steps, and the official sources trustees should check before filing.',
  date: '2026-04-02',
  author: 'CharityPilot Team',
  category: 'Annual Reporting',
  readTime: '7 min read',
  tags: ['annual report', 'CRA', 'filing', 'trustees', 'financial statements', 'compliance'],
};

const sourceLinkClassName =
  'inline-flex items-center gap-1 font-medium text-teal-700 underline decoration-teal-300 underline-offset-2 hover:text-teal-900 dark:text-teal-300 dark:decoration-teal-700 dark:hover:text-teal-100';

export default function AnnualReportingGuide() {
  return (
    <article className="max-w-3xl mx-auto px-4 py-8 text-gray-800 dark:text-gray-100">
      <p className="text-lg leading-relaxed text-gray-700 dark:text-gray-300 mb-6">
        Registered charities in Ireland file an online Annual Report with the Charities Regulator.
        This guide explains the planning steps supported by current official sources. It does not
        decide which accounting, examination, or audit rules apply to a particular organisation.
      </p>

      <div className="border-l-4 border-amber-500 bg-amber-50 px-5 py-4 rounded-lg mb-8 dark:bg-amber-950/30">
        <p className="text-sm font-semibold text-amber-900 dark:text-amber-100 mb-1">
          Legal and accounting scope
        </p>
        <p className="text-sm text-amber-800 dark:text-amber-200 leading-relaxed">
          This article is general information, not legal or accounting advice. Requirements can
          depend on legal form, other legislation, regulator directions, and current commencement
          status. Confirm your charity&apos;s position with a suitably qualified accountant or
          solicitor before approving accounts or appointing an examiner or auditor.
        </p>
      </div>

      <h2 className="text-2xl font-bold text-gray-900 dark:text-white mt-10 mb-4">
        The filing obligation and deadline
      </h2>
      <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300 mb-4">
        The Charities Regulator&apos;s current guidance says that each charity should submit an
        online Annual Report within 10 months of the end of its financial year. Section 52 of the
        Charities Act 2009 states 10 months or a longer period that the Authority may specify. Use
        the live regulator service when filing because the form, supporting guidance, or a formally
        specified period can change.
      </p>
      <div className="border-l-4 border-teal-600 bg-teal-50 px-5 py-4 rounded-lg mb-6 dark:bg-teal-950/30">
        <p className="text-sm font-semibold text-teal-900 dark:text-teal-100 mb-1">
          Standard planning date
        </p>
        <p className="text-sm text-teal-800 dark:text-teal-200 leading-relaxed">
          Plan against the date shown by applying the 10-month rule to the confirmed financial
          year-end, then verify the exact calendar date in the live regulator service. Begin early
          enough for the accounts, narrative, trustee review, and any professional work that applies.
        </p>
      </div>

      <h2 className="text-2xl font-bold text-gray-900 dark:text-white mt-10 mb-4">
        Prepare from the current online form
      </h2>
      <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300 mb-4">
        The regulator&apos;s published material shows that the Annual Report collects information
        about the charity&apos;s activities, finances, people, governance, and other matters relevant
        to the reporting period. Some information is published on the Register of Charities, while
        some fields are not. Review the current form and guidance rather than copying last
        year&apos;s answers without checking them.
      </p>
      <ul className="list-none space-y-3 mb-6">
        {[
          'Confirm the reporting period and the charity details shown on the register.',
          'Reconcile the figures entered in the form to the final, approved financial information that applies to the charity.',
          'Prepare a clear account of activities and how they furthered the charity’s charitable purpose.',
          'Review trustee, employee, volunteer, governance, asset, liability, and international-transfer questions that apply in the live form.',
          'Record the board review and retain the submitted version and supporting evidence.',
        ].map((item) => (
          <li key={item} className="flex gap-3">
            <CheckCircle2
              className="mt-1 h-4 w-4 flex-shrink-0 text-teal-600"
              strokeWidth={1.75}
              aria-hidden="true"
            />
            <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300">{item}</p>
          </li>
        ))}
      </ul>

      <h2 className="text-2xl font-bold text-gray-900 dark:text-white mt-10 mb-4">
        Why this guide does not publish an income-band table
      </h2>
      <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300 mb-4">
        It is unsafe to turn a ceiling, proposal, or not-yet-commenced amendment into a current
        audit threshold. The in-force text of section 50 uses an amount that may be prescribed and
        also contains legal-form and other exceptions. The Irish Statute Book&apos;s current list of
        statutory instruments under the 2009 Act does not show an instrument made under section 50.
        Sections 48 and 50 currently exclude charitable organisations that are companies, but those
        organisations can instead have Companies Act and Companies Registration Office obligations,
        including conditions that govern whether an audit exemption is available.
      </p>
      <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300 mb-4">
        The Charities (Amendment) Act 2024 contains changes to accounting and annual-reporting
        sections, but the official commencement table records sections 17 to 19 as not yet
        commenced at the date checked below. Charities Regulator material about a future Charities
        SORP regime is explicitly described as proposed. None of those sources should be presented
        as a single current income-band table.
      </p>
      <div className="border-l-4 border-red-500 bg-red-50 px-5 py-4 rounded-lg mb-6 dark:bg-red-950/30">
        <div className="flex gap-3">
          <TriangleAlert
            className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-600 dark:text-red-300"
            strokeWidth={1.75}
            aria-hidden="true"
          />
          <p className="text-sm text-red-800 dark:text-red-200 leading-relaxed">
            Do not infer an audit, examination, or accounts requirement from income alone. Confirm
            the organisation&apos;s legal form, applicable legislation, regulator directions, and
            current commencement position with a qualified professional.
          </p>
        </div>
      </div>

      <h2 className="text-2xl font-bold text-gray-900 dark:text-white mt-10 mb-4">
        A review-ready board workflow
      </h2>
      <ol className="list-decimal space-y-3 pl-6 mb-6 text-gray-700 dark:text-gray-300">
        <li>Set the 10-month filing date from the confirmed financial year-end.</li>
        <li>Check the live Annual Report guidance and form for the reporting period.</li>
        <li>Confirm which accounting framework and external scrutiny requirements apply.</li>
        <li>Prepare and reconcile the narrative, financial information, and supporting records.</li>
        <li>Arrange trustee review with enough time to correct omissions before submission.</li>
        <li>Submit through the regulator service and retain the receipt and approved record set.</li>
      </ol>
      <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300 mb-4">
        If the filing date has passed or the correct treatment is unclear, use the regulator&apos;s
        current contact guidance and obtain professional advice. Do not rely on an old article,
        copied threshold table, or software-generated status as a legal conclusion.
      </p>

      <h2 className="text-2xl font-bold text-gray-900 dark:text-white mt-10 mb-4">
        How CharityPilot supports the process
      </h2>
      <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300 mb-4">
        CharityPilot can store the financial year-end, calculate the source-cited 10-month planning
        date, send reminders, and keep review evidence together. It does not file the Annual Report,
        select the accounting framework, decide whether an audit or examination applies, or replace
        trustee and professional judgment. Trustees must verify the live regulator requirements and
        complete the filing outside CharityPilot.
      </p>

      <h2 className="text-2xl font-bold text-gray-900 dark:text-white mt-10 mb-4">
        Official sources and status
      </h2>
      <div className="rounded-lg border border-gray-200 bg-gray-50 px-5 py-4 dark:border-gray-700 dark:bg-gray-900">
        <p className="text-sm font-semibold text-gray-900 dark:text-white mb-3">
          Last checked: 10 July 2026
        </p>
        <ul className="space-y-3 text-sm text-gray-700 dark:text-gray-300">
          <li>
            <a
              className={sourceLinkClassName}
              href="https://www.charitiesregulator.ie/en/information-for-charities/annual-report-how-to-submit"
              target="_blank"
              rel="noreferrer"
            >
              Charities Regulator Annual Report guidance
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </a>{' '}
            — current regulator guidance; check again when filing.
          </li>
          <li>
            <a
              className={sourceLinkClassName}
              href="https://www.charitiesregulator.ie/media/1501/annual-report-user-guide-revised-2-august.pdf"
              target="_blank"
              rel="noreferrer"
            >
              Charities Regulator Annual Report User Guide
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </a>{' '}
            — official form and filing context; verify it against the live service.
          </li>
          <li>
            <a
              className={sourceLinkClassName}
              href="https://www.charitiesregulator.ie/media/2329/annual-reporting-information-note-final.pdf"
              target="_blank"
              rel="noreferrer"
            >
              Charities Regulator Annual Reporting Information Note
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </a>{' '}
            — official detail about form fields and public-register visibility.
          </li>
          <li>
            <a
              className={sourceLinkClassName}
              href="https://revisedacts.lawreform.ie/eli/2009/act/6/section/48/revised/en/html"
              target="_blank"
              rel="noreferrer"
            >
              Charities Act 2009, revised section 48
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </a>{' '}
            — in force; annual accounts provisions and exceptions.
          </li>
          <li>
            <a
              className={sourceLinkClassName}
              href="https://revisedacts.lawreform.ie/eli/2009/act/6/section/50/revised/en/html"
              target="_blank"
              rel="noreferrer"
            >
              Charities Act 2009, revised section 50
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </a>{' '}
            — in force; organisation-specific accounting scrutiny provisions and exceptions.
          </li>
          <li>
            <a
              className={sourceLinkClassName}
              href="https://revisedacts.lawreform.ie/eli/2009/act/6/section/52/revised/en/html"
              target="_blank"
              rel="noreferrer"
            >
              Charities Act 2009, revised section 52
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </a>{' '}
            — in force; annual-report provision, including the period the Authority may specify.
          </li>
          <li>
            <a
              className={sourceLinkClassName}
              href="https://www.irishstatutebook.ie/eli/2009/act/isbc/2009_6.html"
              target="_blank"
              rel="noreferrer"
            >
              Irish Statute Book effects and statutory-instrument table
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </a>{' '}
            — current source for commencement and instruments made under the 2009 Act.
          </li>
          <li>
            <a
              className={sourceLinkClassName}
              href="https://www.irishstatutebook.ie/eli/isbc/2024_21.html"
              target="_blank"
              rel="noreferrer"
            >
              Charities (Amendment) Act 2024 commencement table
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </a>{' '}
            — sections 17 to 19 not yet commenced when checked.
          </li>
          <li>
            <a
              className={sourceLinkClassName}
              href="https://www.charitiesregulator.ie/media/4569/guidance-on-charities-sorp.pdf"
              target="_blank"
              rel="noreferrer"
            >
              Charities Regulator guidance on the proposed Charities SORP regime
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </a>{' '}
            — proposal context, not a statement that the regime is in force.
          </li>
          <li>
            <a
              className={sourceLinkClassName}
              href="https://cro.ie/annual-return/financial-statements-requirements/"
              target="_blank"
              rel="noreferrer"
            >
              Companies Registration Office financial-statement requirements
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </a>{' '}
            — company-specific filing context.
          </li>
          <li>
            <a
              className={sourceLinkClassName}
              href="https://cro.ie/annual-return/financial-statements-requirements/audit-exemption/"
              target="_blank"
              rel="noreferrer"
            >
              Companies Registration Office audit-exemption guidance
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </a>{' '}
            — conditional company audit-exemption rules; not a universal charity threshold.
          </li>
        </ul>
        <p className="text-sm text-gray-700 dark:text-gray-300 mt-4">
          Professional review status: accountant and solicitor approval is still required before
          this content is treated as production-approved guidance.
        </p>
      </div>
    </article>
  );
}
