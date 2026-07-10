import type { PostMeta } from '@/lib/blog';

export const meta: PostMeta = {
  slug: 'simple-vs-complex-charity-classification',
  title: 'Simple vs Complex: Which Charities Governance Code Standards Apply to Your Charity?',
  excerpt:
    'The CRA distinguishes between non-complex and complex charities, with different numbers of standards applying to each. Getting your classification right is the first step to compliance.',
  date: '2026-03-28',
  author: 'CharityPilot Team',
  category: 'Compliance',
  readTime: '6 min read',
  tags: ['classification', 'complex charity', 'simple charity', 'CRA', 'governance standards'],
};

export default function SimpleVsComplexCharityClassification() {
  return (
    <article className="max-w-3xl mx-auto px-4 py-10 text-gray-900 dark:text-white">

      {/* Intro */}
      <p className="text-lg leading-relaxed text-gray-700 dark:text-gray-300 mb-6">
        One of the first questions any trustee needs to answer when working through the Charities
        Governance Code is: does our charity need to meet 32 standards or 49? The answer depends on
        whether the CRA classifies you as a <em>non-complex</em> charity or a <em>complex</em>{' '}
        charity. Getting this right is not just a formality — it determines the entire scope of your
        compliance obligations.
      </p>
      <p className="text-lg leading-relaxed text-gray-700 dark:text-gray-300 mb-10">
        This article explains the classification criteria in plain terms, walks through what changes
        at each tier, and gives practical guidance on what to do if you are unsure which category
        your charity falls into.
      </p>

      {/* Section 1 */}
      <h2 className="text-2xl font-bold text-gray-900 dark:text-white mt-10 mb-4">
        The CRA's Two-Tier Classification
      </h2>
      <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300 mb-4">
        The Charities Governance Code acknowledges that a small community group run entirely by
        volunteers has very different governance needs from a national charity with dozens of staff
        and multimillion-euro income. Rather than applying a one-size-fits-all set of obligations,
        the Code creates two tiers of compliance based on the nature and scale of the organisation.
      </p>
      <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300 mb-4">
        Both tiers share a common foundation of 32 core standards that every registered Irish
        charity must meet, regardless of size. But charities that meet any one of three specific
        criteria are classified as complex and must additionally comply with 17 further standards,
        bringing their total to 49.
      </p>
      <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300 mb-10">
        Critically, these criteria are framed as an <span className="font-semibold">OR</span>{' '}
        condition, not an AND. You do not need to meet all three to be classified as complex — any
        single criterion is sufficient.
      </p>

      {/* Section 2 — Three Criteria */}
      <h2 className="text-2xl font-bold text-gray-900 dark:text-white mt-10 mb-6">
        Signals That Your Charity Should Apply the Additional Standards
      </h2>

      {/* Criterion 1 */}
      <div className="bg-teal-primary/10 rounded-lg p-6 mb-5">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">
          1. Scale, Income, and Financial Complexity
        </h3>
        <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300">
          A charity with substantial income, multiple funders, restricted funds, trading activity,
          subsidiaries, or higher financial risk should consider whether the additional standards
          are appropriate. Trustees should make and record that judgement in the context of the
          charity's own size, resources, and operating model.
        </p>
      </div>

      {/* Criterion 2 */}
      <div className="bg-teal-primary/10 rounded-lg p-6 mb-5">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">
          2. Paid Staff, Volunteers, and Delegated Work
        </h3>
        <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300">
          Paid staff, large volunteer teams, contractors, branches, or committees can increase the
          governance load. The additional standards help trustees document roles, supervision,
          delegation, training, and accountability where work is no longer carried out directly by
          the board.
        </p>
      </div>

      {/* Criterion 3 */}
      <div className="bg-teal-primary/10 rounded-lg p-6 mb-5">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">
          3. Complex Activities, Structures, or Risk
        </h3>
        <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300">
          Cross-border work, regulated services, safeguarding exposure, fundraising at scale,
          partnerships, mergers, restricted grants, or public-contract delivery can all increase the
          level of oversight needed. The point is whether the board has enough structure to control
          the risks it has actually taken on.
        </p>
      </div>

      <div className="border-l-4 border-amber-accent pl-5 mb-10">
        <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300 font-medium">
          Record your reasoning. If the board decides that the additional standards apply, keep
          that decision with the annual Compliance Record Form and review it each year.
        </p>
      </div>

      {/* Section 3 — The 32 Core Standards */}
      <h2 className="text-2xl font-bold text-gray-900 dark:text-white mt-10 mb-4">
        The 32 Core Standards: The Foundation for Everyone
      </h2>
      <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300 mb-4">
        The 32 core standards span all six principles of the Charities Governance Code and
        represent the baseline of good governance that every Irish charity — however small — must
        demonstrate. They include:
      </p>
      <ul className="list-disc list-outside pl-6 space-y-3 text-base leading-relaxed text-gray-700 dark:text-gray-300 mb-6">
        <li>
          Having an up-to-date governing document that clearly describes the charity's purpose,
          the role of trustees, and how decisions are made.
        </li>
        <li>
          A written conflicts of interest policy and a register of trustee interests that is
          reviewed and updated at least annually.
        </li>
        <li>
          Board meeting minutes that accurately record attendance, discussion, and decisions.
          Meetings must take place at a minimum frequency sufficient to discharge trustee duties
          (in practice, at least four times per year).
        </li>
        <li>
          A risk register identifying the key risks to the charity, with controls assigned and
          reviewed at least annually by the board.
        </li>
        <li>
          Basic financial controls covering authorisation of expenditure, bank signatory
          requirements, and separation of financial duties.
        </li>
        <li>
          Annual filing of the Charities Regulator Annual Report, with the financial information
          or documents that apply to the charity&apos;s legal form and current reporting period.
        </li>
        <li>
          A complaints procedure accessible to members of the public.
        </li>
        <li>
          Evidence that trustees understand their legal duties under the Charities Act 2009 and
          the charity's own governing document.
        </li>
      </ul>
      <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300 mb-10">
        A small volunteer-run charity should still work through the core standards, record its
        governance decisions, and file its Annual Report on time. The accounting material attached
        to that report must be checked separately against its legal form and current requirements.
      </p>

      {/* Section 4 — The 17 Additional Standards */}
      <h2 className="text-2xl font-bold text-gray-900 dark:text-white mt-10 mb-4">
        The 17 Additional Standards: What Complex Charities Must Also Meet
      </h2>
      <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300 mb-4">
        The 17 additional standards build on the core foundation and address the increased risks
        and responsibilities that come with greater scale. They broadly cover:
      </p>
      <ul className="list-disc list-outside pl-6 space-y-3 text-base leading-relaxed text-gray-700 dark:text-gray-300 mb-6">
        <li>
          <span className="font-semibold">HR and people management</span> — Written employment
          policies covering recruitment, performance management, disciplinary and grievance
          procedures, and staff development. A formal structure for managing the CEO or senior
          manager's performance and remuneration.
        </li>
        <li>
          <span className="font-semibold">Formal subcommittee structures</span> — Larger
          organisations are expected to have dedicated committees (audit, finance, remuneration)
          with written terms of reference, rather than managing everything at full board level.
        </li>
        <li>
          <span className="font-semibold">Enhanced financial oversight</span> — More robust
          internal controls, formal budget approval processes, regular financial reporting to the
          board (typically monthly or quarterly management accounts), plus any independent audit,
          examination, or other scrutiny required by entity-specific law, a regulator direction,
          the governing document, or a funder. A qualified professional should confirm what applies.
        </li>
        <li>
          <span className="font-semibold">Trustee skills audit and succession planning</span> —
          A formal assessment of the skills and experience currently on the board, gaps identified,
          and a structured plan for recruitment and succession.
        </li>
        <li>
          <span className="font-semibold">Stakeholder engagement and reporting</span> — A more
          structured approach to engaging with beneficiaries, funders, and the public, and a
          review-ready narrative and financial reporting appropriate to the charity&apos;s legal form
          and the current official reporting guidance.
        </li>
        <li>
          <span className="font-semibold">External review of governance</span> — Complex charities
          should periodically commission or conduct an external review of their governance
          arrangements, not just an internal self-assessment.
        </li>
      </ul>

      {/* Section 5 — Classification Changes Year to Year */}
      <h2 className="text-2xl font-bold text-gray-900 dark:text-white mt-10 mb-4">
        What If Your Classification Changes Year to Year?
      </h2>
      <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300 mb-4">
        This is a genuinely common situation. A charity might receive a once-off bequest, take on
        its first employee, start a regulated service, create a subsidiary, or later simplify its
        activities. Each change can affect the board&apos;s view of organisational complexity.
      </p>
      <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300 mb-4">
        Reassess the additional standards against the current Governance Code guidance and the
        charity&apos;s actual size, structure, activities, staffing, and risk. The board should record
        what it considered, the source version it used, and why it selected its current scope. Do
        not use a single income figure or an unsupported year-to-year carry-over rule as a shortcut.
      </p>
      <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300 mb-10">
        If the appropriate scope remains unclear, use the Regulator&apos;s current material and seek
        governance or legal advice before making a certainty claim. Additional standards can still
        be adopted as good practice without presenting that choice as a legal classification.
      </p>

      {/* Section 6 — When in Doubt */}
      <h2 className="text-2xl font-bold text-gray-900 dark:text-white mt-10 mb-4">
        Practical Advice: When in Doubt, Treat Yourself as Complex
      </h2>
      <div className="border-l-4 border-teal-primary pl-5 mb-6">
        <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300">
          If the board is unsure, it may choose to work through all 49 standards as a governance
          improvement exercise while it verifies the applicable scope. Record that choice and any
          professional advice. Applying extra controls can be useful, but CharityPilot does not
          determine the charity&apos;s legal obligations or remove the need to check official guidance.
        </p>
      </div>
      <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300 mb-4">
        There is also a reputational dimension. Major funders and institutional donors increasingly
        ask charities to demonstrate governance quality as part of due diligence. A charity that
        voluntarily meets the higher standard, even where not legally required, sends a strong
        signal about the seriousness with which its board takes its responsibilities.
      </p>

      {/* Section 7 — CharityPilot Plans */}
      <h2 className="text-2xl font-bold text-gray-900 dark:text-white mt-10 mb-4">
        How CharityPilot Maps to This Classification
      </h2>
      <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300 mb-4">
        CharityPilot's two plans are designed precisely around this classification framework.
      </p>
      <div className="grid sm:grid-cols-2 gap-5 mb-6">
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-5">
          <h3 className="text-base font-semibold text-gray-900 dark:text-white mb-2">Essentials Plan</h3>
          <p className="text-sm leading-relaxed text-gray-700 dark:text-gray-300">
            Covers all 32 core standards. Designed for non-complex charities: volunteer-run
            organisations applying the core standards only. Includes templates, document storage,
            and annual filing reminders.
          </p>
        </div>
        <div className="bg-teal-primary/10 border border-teal-primary/30 rounded-lg p-5">
          <h3 className="text-base font-semibold text-gray-900 dark:text-white mb-2">Complete Plan</h3>
          <p className="text-sm leading-relaxed text-gray-700 dark:text-gray-300">
            Covers all 49 standards. Designed for complex charities and for any non-complex charity
            that wants the confidence of meeting the higher bar. Adds HR policy templates,
            subcommittee tracking, enhanced financial oversight tools, and a full Trustees' Annual
            Report builder.
          </p>
        </div>
      </div>
      <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300">
        When you set up your CharityPilot account, the platform helps trustees record a working
        scope and configures the compliance dashboard with the selected standards. If that scope
        changes, updating it adjusts the dashboard immediately. The configuration is a workflow aid,
        not a legal conclusion; trustees remain responsible for checking current official guidance
        and recording why the selected scope is appropriate.
      </p>
    </article>
  );
}
