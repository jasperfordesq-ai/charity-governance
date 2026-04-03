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
    <article className="max-w-3xl mx-auto px-4 py-10 text-gray-900">

      {/* Intro */}
      <p className="text-lg leading-relaxed text-gray-700 mb-6">
        One of the first questions any trustee needs to answer when working through the Charities
        Governance Code is: does our charity need to meet 32 standards or 49? The answer depends on
        whether the CRA classifies you as a <em>non-complex</em> charity or a <em>complex</em>{' '}
        charity. Getting this right is not just a formality — it determines the entire scope of your
        compliance obligations.
      </p>
      <p className="text-lg leading-relaxed text-gray-700 mb-10">
        This article explains the classification criteria in plain terms, walks through what changes
        at each tier, and gives practical guidance on what to do if you are unsure which category
        your charity falls into.
      </p>

      {/* Section 1 */}
      <h2 className="text-2xl font-bold text-gray-900 mt-10 mb-4">
        The CRA's Two-Tier Classification
      </h2>
      <p className="text-base leading-relaxed text-gray-700 mb-4">
        The Charities Governance Code acknowledges that a small community group run entirely by
        volunteers has very different governance needs from a national charity with dozens of staff
        and multimillion-euro income. Rather than applying a one-size-fits-all set of obligations,
        the Code creates two tiers of compliance based on the nature and scale of the organisation.
      </p>
      <p className="text-base leading-relaxed text-gray-700 mb-4">
        Both tiers share a common foundation of 32 core standards that every registered Irish
        charity must meet, regardless of size. But charities that meet any one of three specific
        criteria are classified as complex and must additionally comply with 17 further standards,
        bringing their total to 49.
      </p>
      <p className="text-base leading-relaxed text-gray-700 mb-10">
        Critically, these criteria are framed as an <span className="font-semibold">OR</span>{' '}
        condition, not an AND. You do not need to meet all three to be classified as complex — any
        single criterion is sufficient.
      </p>

      {/* Section 2 — Three Criteria */}
      <h2 className="text-2xl font-bold text-gray-900 mt-10 mb-6">
        The Three Criteria That Make a Charity "Complex"
      </h2>

      {/* Criterion 1 */}
      <div className="bg-teal-primary/10 rounded-xl p-6 mb-5">
        <h3 className="text-lg font-semibold text-gray-900 mb-2">
          1. Annual Income Over €100,000
        </h3>
        <p className="text-base leading-relaxed text-gray-700">
          If your charity's gross annual income in its most recently completed financial year
          exceeded €100,000, you are complex. This threshold is measured against gross income —
          that is, total receipts before any expenses — and includes all sources: donations,
          grants, fundraising, trading income, and investment returns. The threshold applies to the
          charity as a single entity; if your charity controls subsidiary companies or operates
          programmes through a separate legal structure, each entity is assessed separately, though
          aggregated group income may be relevant to how the CRA views you in practice.
        </p>
      </div>

      {/* Criterion 2 */}
      <div className="bg-teal-primary/10 rounded-xl p-6 mb-5">
        <h3 className="text-lg font-semibold text-gray-900 mb-2">
          2. Has Paid Employees
        </h3>
        <p className="text-base leading-relaxed text-gray-700">
          If your charity employs any paid staff — even one part-time employee — it is complex.
          This criterion reflects the additional legal and governance obligations that come with
          being an employer: employment law compliance, HR policies, payroll, PRSI obligations,
          performance management, and workplace safety. The moment a charity has employees, there
          are people whose livelihoods and wellbeing depend on the organisation being properly
          governed. The Code's additional standards in this area are designed to ensure that
          employment relationships are managed responsibly. Note that engaging contractors or
          self-employed service providers is generally distinct from employment, but this should be
          reviewed carefully to ensure correct classification under Revenue and employment law.
        </p>
      </div>

      {/* Criterion 3 */}
      <div className="bg-teal-primary/10 rounded-xl p-6 mb-5">
        <h3 className="text-lg font-semibold text-gray-900 mb-2">
          3. Operates in More Than One Jurisdiction
        </h3>
        <p className="text-base leading-relaxed text-gray-700">
          If your charity carries out activities in more than one country — whether that means
          running programmes in Ireland and Northern Ireland, providing international development
          aid abroad, or having a branch network that crosses jurisdictional boundaries — it is
          complex. Cross-border operations introduce legal, regulatory, and reputational risks that
          require more sophisticated governance oversight, particularly around anti-money laundering
          obligations, foreign funding disclosures, and the due diligence required when partnering
          with overseas organisations.
        </p>
      </div>

      <div className="border-l-4 border-amber-accent pl-5 mb-10">
        <p className="text-base leading-relaxed text-gray-700 font-medium">
          Remember: any <span className="font-bold">one</span> of these three criteria is
          sufficient. A tiny charity with only €30,000 income and no overseas activities is
          still complex if it employs even one part-time administrator.
        </p>
      </div>

      {/* Section 3 — The 32 Core Standards */}
      <h2 className="text-2xl font-bold text-gray-900 mt-10 mb-4">
        The 32 Core Standards: The Foundation for Everyone
      </h2>
      <p className="text-base leading-relaxed text-gray-700 mb-4">
        The 32 core standards span all six principles of the Charities Governance Code and
        represent the baseline of good governance that every Irish charity — however small — must
        demonstrate. They include:
      </p>
      <ul className="list-disc list-outside pl-6 space-y-3 text-base leading-relaxed text-gray-700 mb-6">
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
          Annual filing of the Charities Regulator Annual Report and financial statements within
          the statutory deadline.
        </li>
        <li>
          A complaints procedure accessible to members of the public.
        </li>
        <li>
          Evidence that trustees understand their legal duties under the Charities Act 2009 and
          the charity's own governing document.
        </li>
      </ul>
      <p className="text-base leading-relaxed text-gray-700 mb-10">
        These are not optional even for the smallest charity. A volunteer-run community group with
        five trustees and €15,000 in annual donations is still required to have a written conflicts
        of interest policy, to minute its meetings, and to file its Annual Report on time.
      </p>

      {/* Section 4 — The 17 Additional Standards */}
      <h2 className="text-2xl font-bold text-gray-900 mt-10 mb-4">
        The 17 Additional Standards: What Complex Charities Must Also Meet
      </h2>
      <p className="text-base leading-relaxed text-gray-700 mb-4">
        The 17 additional standards build on the core foundation and address the increased risks
        and responsibilities that come with greater scale. They broadly cover:
      </p>
      <ul className="list-disc list-outside pl-6 space-y-3 text-base leading-relaxed text-gray-700 mb-6">
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
          board (typically monthly or quarterly management accounts), and, for charities above the
          relevant threshold, an independent audit rather than a simple compilation of accounts.
        </li>
        <li>
          <span className="font-semibold">Trustee skills audit and succession planning</span> —
          A formal assessment of the skills and experience currently on the board, gaps identified,
          and a structured plan for recruitment and succession.
        </li>
        <li>
          <span className="font-semibold">Stakeholder engagement and reporting</span> — A more
          structured approach to engaging with beneficiaries, funders, and the public, and a
          Trustees' Annual Report that meets the detailed content requirements set out in the
          Charities (Accounts and Audit) Regulations.
        </li>
        <li>
          <span className="font-semibold">External review of governance</span> — Complex charities
          should periodically commission or conduct an external review of their governance
          arrangements, not just an internal self-assessment.
        </li>
      </ul>

      {/* Section 5 — Classification Changes Year to Year */}
      <h2 className="text-2xl font-bold text-gray-900 mt-10 mb-4">
        What If Your Classification Changes Year to Year?
      </h2>
      <p className="text-base leading-relaxed text-gray-700 mb-4">
        This is a genuinely common situation. A charity might receive a once-off bequest that pushes
        its income above €100,000 in one year but falls back below in the next. Or a charity might
        take on its first employee mid-year and then let that contract lapse.
      </p>
      <p className="text-base leading-relaxed text-gray-700 mb-4">
        The CRA's guidance is clear: you assess your classification at the start of each reporting
        year based on the position at the end of the most recently completed financial year. If you
        were complex last year, you report against all 49 standards in your current year's self-
        assessment, even if your circumstances have changed. If you believe your classification has
        genuinely and permanently changed (for example, the bequest was clearly a one-time event),
        you should document that reasoning carefully.
      </p>
      <p className="text-base leading-relaxed text-gray-700 mb-10">
        The administrative burden of temporarily reverting to the 32-core-only framework is
        generally not worth the risk of misclassifying yourself. Which brings us to the most
        important piece of practical advice in this article.
      </p>

      {/* Section 6 — When in Doubt */}
      <h2 className="text-2xl font-bold text-gray-900 mt-10 mb-4">
        Practical Advice: When in Doubt, Treat Yourself as Complex
      </h2>
      <div className="border-l-4 border-teal-primary pl-5 mb-6">
        <p className="text-base leading-relaxed text-gray-700">
          If you are genuinely unsure whether your charity meets one of the three complexity
          criteria, the safest and most defensible course of action is to comply with all 49
          standards. The additional 17 standards represent genuinely good governance practice that
          any well-run organisation should be working toward regardless of its legal obligation to
          do so. Over-complying carries no regulatory risk. Under-complying — even innocently —
          can be difficult to explain if the CRA queries your self-assessment.
        </p>
      </div>
      <p className="text-base leading-relaxed text-gray-700 mb-4">
        There is also a reputational dimension. Major funders and institutional donors increasingly
        ask charities to demonstrate governance quality as part of due diligence. A charity that
        voluntarily meets the higher standard, even where not legally required, sends a strong
        signal about the seriousness with which its board takes its responsibilities.
      </p>

      {/* Section 7 — CharityPilot Plans */}
      <h2 className="text-2xl font-bold text-gray-900 mt-10 mb-4">
        How CharityPilot Maps to This Classification
      </h2>
      <p className="text-base leading-relaxed text-gray-700 mb-4">
        CharityPilot's two plans are designed precisely around this classification framework.
      </p>
      <div className="grid sm:grid-cols-2 gap-5 mb-6">
        <div className="bg-gray-50 border border-gray-200 rounded-xl p-5">
          <h3 className="text-base font-semibold text-gray-900 mb-2">Essentials Plan</h3>
          <p className="text-sm leading-relaxed text-gray-700">
            Covers all 32 core standards. Designed for non-complex charities: volunteer-run
            organisations with income under €100k, no paid employees, and operating solely within
            Ireland. Includes templates, document storage, and annual filing reminders.
          </p>
        </div>
        <div className="bg-teal-primary/10 border border-teal-primary/30 rounded-xl p-5">
          <h3 className="text-base font-semibold text-gray-900 mb-2">Complete Plan</h3>
          <p className="text-sm leading-relaxed text-gray-700">
            Covers all 49 standards. Designed for complex charities and for any non-complex charity
            that wants the confidence of meeting the higher bar. Adds HR policy templates,
            subcommittee tracking, enhanced financial oversight tools, and a full Trustees' Annual
            Report builder.
          </p>
        </div>
      </div>
      <p className="text-base leading-relaxed text-gray-700">
        When you set up your CharityPilot account, the platform asks you a short series of questions
        to determine your classification and automatically configures your compliance dashboard with
        the correct set of standards. If your status changes, updating it takes seconds and the
        dashboard adjusts immediately — so you always know exactly what is required of your charity
        this year.
      </p>
    </article>
  );
}
