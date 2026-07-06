import type { PostMeta } from '@/lib/blog';

export const meta: PostMeta = {
  slug: 'understanding-the-charities-governance-code',
  title: 'Understanding the Charities Governance Code: A Complete Guide',
  excerpt:
    "The CRA Charities Governance Code sets out the minimum standards every registered Irish charity must meet. Here's a full walkthrough of the six principles and what compliance looks like in practice.",
  date: '2026-03-20',
  author: 'CharityPilot Team',
  category: 'Governance',
  readTime: '10 min read',
  tags: ['governance', 'CRA', 'Charities Governance Code', 'compliance', 'trustees'],
};

export default function UnderstandingTheCharitiesGovernanceCode() {
  return (
    <article className="max-w-3xl mx-auto px-4 py-10 text-gray-900">

      {/* Intro */}
      <p className="text-lg leading-relaxed text-gray-700 mb-6">
        If you serve as a trustee or manager of a registered Irish charity, the Charities Governance
        Code is the single most important compliance document you need to understand. Issued by the
        Charities Regulator (CRA) and effective since 2020, the Code sets out the minimum standards
        of governance that every registered charity in Ireland must meet. Non-compliance is not just
        a tick-box failure — the CRA can and does use governance shortfalls as grounds for
        investigation and intervention.
      </p>
      <p className="text-lg leading-relaxed text-gray-700 mb-10">
        This guide walks you through what the Code actually requires, how its standards are
        structured, and what "being compliant" means in practical, day-to-day terms.
      </p>

      {/* Section 1 */}
      <h2 className="text-2xl font-bold text-gray-900 mt-10 mb-4">
        What Is the Charities Governance Code and Why Was It Introduced?
      </h2>
      <p className="text-base leading-relaxed text-gray-700 mb-4">
        The Charities Act 2009 gave the CRA wide-ranging powers to regulate the Irish charity
        sector. For years, however, there was no single, coherent framework telling charities{' '}
        <em>how</em> to govern themselves well. The Code fills that gap. It was developed through
        extensive consultation with the sector and draws on international best practice in charity
        governance, including the UK Charity Governance Code and the principles underpinning the
        Companies Act.
      </p>
      <p className="text-base leading-relaxed text-gray-700 mb-4">
        The Code's purpose is twofold. First, it protects the public by ensuring that charitable
        assets are managed responsibly and that charities deliver on their stated purposes. Second,
        it protects charities themselves: organisations with strong governance are better placed to
        attract funding, retain volunteers, and weather crises. Many grant-making bodies — including
        the Department of Rural and Community Development, Pobal, and the Health Service Executive —
        now require evidence of Code compliance as part of their funding applications.
      </p>
      <p className="text-base leading-relaxed text-gray-700 mb-10">
        The Code is structured around six principles, each supported by a set of specific
        standards that charities must meet. All registered charities in Ireland must comply with the
        32 core standards; larger or more complex charities must additionally meet 17 further
        standards, bringing the total to 49. We will look at the core/additional split in more
        detail below, but first let us walk through the six principles themselves.
      </p>

      {/* Section 2 — The Six Principles */}
      <h2 className="text-2xl font-bold text-gray-900 mt-10 mb-6">
        The Six Principles of the Charities Governance Code
      </h2>

      {/* Principle 1 */}
      <div className="border-l-4 border-teal-primary pl-5 mb-8">
        <h3 className="text-xl font-semibold text-gray-900 mb-2">
          Principle 1 — Advancing Charitable Purpose
        </h3>
        <p className="text-base leading-relaxed text-gray-700 mb-3">
          Everything a charity does must be in furtherance of its charitable purpose as stated in
          its governing document. This principle requires trustees to have a clear, shared
          understanding of what the organisation exists to do, to ensure all activities and
          expenditure advance that purpose, and to regularly review whether programmes are actually
          achieving the intended impact.
        </p>
        <p className="text-base leading-relaxed text-gray-700">
          In practice, this means your board must document its charitable purpose clearly, review it
          periodically, and be able to demonstrate a direct link between every material activity and
          that purpose. If your charity has accumulated funds that are not being deployed toward your
          mission, that itself can raise questions under this principle.
        </p>
      </div>

      {/* Principle 2 */}
      <div className="border-l-4 border-teal-primary pl-5 mb-8">
        <h3 className="text-xl font-semibold text-gray-900 mb-2">
          Principle 2 — Behaving with Integrity
        </h3>
        <p className="text-base leading-relaxed text-gray-700 mb-3">
          Trustees must act honestly and ethically at all times. This principle covers conflicts of
          interest, benefits to trustees, and the duty to put the charity's interests ahead of
          personal interests. It requires charities to have a written conflicts of interest policy,
          a register of interests, and a clear process for managing situations where a trustee's
          personal or professional interests could influence decision-making.
        </p>
        <p className="text-base leading-relaxed text-gray-700">
          Integrity also extends to the organisation's culture: staff, volunteers, and the public
          must be able to trust that the charity operates honestly. Policies on protected disclosures
          (whistleblowing) and a commitment to transparency in decision-making sit under this
          principle.
        </p>
      </div>

      {/* Principle 3 */}
      <div className="border-l-4 border-teal-primary pl-5 mb-8">
        <h3 className="text-xl font-semibold text-gray-900 mb-2">
          Principle 3 — Leading People
        </h3>
        <p className="text-base leading-relaxed text-gray-700 mb-3">
          Effective governance depends on having the right people around the boardroom table and
          ensuring those people are equipped to lead. This principle covers the composition of the
          board, trustee recruitment and induction, succession planning, and the relationship
          between the board and any paid staff or chief executive.
        </p>
        <p className="text-base leading-relaxed text-gray-700">
          Standards under this principle require charities to have a written description of the
          skills and experience the board needs, to conduct periodic reviews of board performance,
          and to ensure trustees understand their legal duties. If your charity employs staff, there
          must be a clear, documented distinction between the strategic role of trustees and the
          operational role of management.
        </p>
      </div>

      {/* Principle 4 */}
      <div className="border-l-4 border-teal-primary pl-5 mb-8">
        <h3 className="text-xl font-semibold text-gray-900 mb-2">
          Principle 4 — Exercising Control
        </h3>
        <p className="text-base leading-relaxed text-gray-700 mb-3">
          Trustees are ultimately responsible for the charity's resources — financial and otherwise.
          This principle covers internal financial controls, risk management, legal compliance, and
          the oversight of any delegated authority. It requires the board to understand and manage
          the key risks facing the organisation and to maintain adequate controls to protect assets.
        </p>
        <p className="text-base leading-relaxed text-gray-700">
          Key outputs expected under this principle include a written risk register reviewed at least
          annually, documented financial controls (covering authorisation of expenditure, bank
          signatories, and petty cash), and a process for ensuring the charity complies with all
          applicable legislation — from employment law to data protection to health and safety.
        </p>
      </div>

      {/* Principle 5 */}
      <div className="border-l-4 border-teal-primary pl-5 mb-8">
        <h3 className="text-xl font-semibold text-gray-900 mb-2">
          Principle 5 — Working Effectively
        </h3>
        <p className="text-base leading-relaxed text-gray-700 mb-3">
          A well-run board is one that meets regularly, makes decisions efficiently, and continually
          improves. This principle addresses how the board and its subcommittees operate: meeting
          frequency, agenda management, minute-taking, decision-making processes, and the role of
          the chairperson. It also covers strategic planning and the charity's approach to
          monitoring its own performance.
        </p>
        <p className="text-base leading-relaxed text-gray-700">
          In concrete terms, the Code expects trustees to meet at least four times per year, for
          meetings to be properly minuted and for minutes to be approved, and for the board to have
          a current strategic plan that is reviewed against measurable objectives.
        </p>
      </div>

      {/* Principle 6 */}
      <div className="border-l-4 border-teal-primary pl-5 mb-8">
        <h3 className="text-xl font-semibold text-gray-900 mb-2">
          Principle 6 — Being Accountable and Transparent
        </h3>
        <p className="text-base leading-relaxed text-gray-700 mb-3">
          Public trust in the charity sector depends on organisations being open about how they
          operate and what they achieve. This principle covers annual reporting, publication of
          accounts, engagement with beneficiaries, donors and other stakeholders, and compliance
          with the CRA's own reporting requirements.
        </p>
        <p className="text-base leading-relaxed text-gray-700">
          Standards under this principle include filing the Annual Report and accounts with the CRA
          on time, making financial information publicly accessible, and having a procedure for
          handling complaints from members of the public. Larger charities must also submit a
          Trustees' Annual Report that meets specific content requirements set out in the Charities
          (Accounts and Audit) Regulations.
        </p>
      </div>

      {/* Section 3 — Core vs Additional */}
      <h2 className="text-2xl font-bold text-gray-900 mt-10 mb-4">
        Core Standards vs Additional Standards
      </h2>
      <p className="text-base leading-relaxed text-gray-700 mb-4">
        The Code recognises that governance expectations must be proportionate to an organisation's
        size and complexity. It therefore divides its standards into two tiers.
      </p>
      <div className="bg-teal-primary/10 rounded-lg p-6 mb-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-3">
          32 Core Standards — Apply to All Registered Charities
        </h3>
        <p className="text-base leading-relaxed text-gray-700">
          Every registered charity in Ireland, regardless of income, headcount, or activities, must
          meet the 32 core standards. These cover the fundamentals: a written governing document,
          a clear statement of purpose, a conflicts of interest policy, basic financial controls, and
          annual reporting obligations. Even a small volunteer-run charity with no paid staff and
          modest income is expected to have these foundations in place.
        </p>
      </div>
      <div className="bg-amber-accent/10 rounded-lg p-6 mb-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-3">
          17 Additional Standards — Apply to Complex Charities (49 Total)
        </h3>
        <p className="text-base leading-relaxed text-gray-700">
          Charities with greater scale, income, staffing, activity, structure, or risk may need to
          apply 17 further standards on top of the core 32. These additional standards cover areas
          such as formal HR policies, more rigorous financial oversight, subcommittee structures, and
          enhanced reporting. The rationale is straightforward: organisations with greater resources
          and reach carry greater risks and are accountable to a wider range of stakeholders.
        </p>
      </div>

      {/* Section 4 — What Compliance Means */}
      <h2 className="text-2xl font-bold text-gray-900 mt-10 mb-4">
        What Does "Compliance" Actually Mean in Practice?
      </h2>
      <p className="text-base leading-relaxed text-gray-700 mb-4">
        A common misconception is that compliance is primarily about ticking boxes on a self-
        assessment form. In reality, the CRA is looking for <em>evidence</em>. If an inspector or
        auditor were to review your charity, they would want to see documented proof that your
        governance practices are real and functioning, not just claimed.
      </p>
      <p className="text-base leading-relaxed text-gray-700 mb-4">
        What does evidence look like? Here are some concrete examples across each principle:
      </p>
      <ul className="list-disc list-outside pl-6 space-y-3 text-base leading-relaxed text-gray-700 mb-6">
        <li>
          <span className="font-semibold">Governing document</span> — An up-to-date constitution,
          memorandum and articles, or trust deed that accurately reflects how the charity is actually
          run. Any amendments should be minuted and filed with the CRA.
        </li>
        <li>
          <span className="font-semibold">Board meeting minutes</span> — Accurate, approved minutes
          of every trustee meeting, recording attendance, decisions made, and votes taken. These
          should be retained for at least six years.
        </li>
        <li>
          <span className="font-semibold">Conflicts of interest register</span> — A written register
          listing all trustee interests (business, personal, family) that could conflict with the
          charity's interests, reviewed and updated annually.
        </li>
        <li>
          <span className="font-semibold">Risk register</span> — A live document identifying the
          key operational, financial, reputational, and strategic risks facing the charity, with
          controls and owners assigned to each risk.
        </li>
        <li>
          <span className="font-semibold">Financial controls policy</span> — A written document
          setting out authorisation limits, dual signatory requirements, bank reconciliation
          procedures, and expense reimbursement rules.
        </li>
        <li>
          <span className="font-semibold">Annual Report filed with the CRA</span> — Submitted on
          time, containing the information required by law, and signed by at least two trustees.
        </li>
        <li>
          <span className="font-semibold">Policies</span> — Written policies covering at least
          child safeguarding (where relevant), data protection (GDPR compliance), protected
          disclosures, and health and safety.
        </li>
      </ul>
      <p className="text-base leading-relaxed text-gray-700 mb-10">
        The CRA's own self-assessment tool asks charities to record whether each standard is "fully
        met", "partially met", or "not met", and to describe their evidence. Honesty matters here:
        regulators are more concerned with charities that have blind spots they do not recognise
        than with those that identify gaps and have a plan to address them.
      </p>

      {/* Section 5 — Common Gaps */}
      <h2 className="text-2xl font-bold text-gray-900 mt-10 mb-4">
        The Most Common Governance Gaps
      </h2>
      <p className="text-base leading-relaxed text-gray-700 mb-4">
        Based on CRA feedback and sector experience, the standards that charities most frequently
        fall short on are:
      </p>
      <ul className="list-disc list-outside pl-6 space-y-3 text-base leading-relaxed text-gray-700 mb-6">
        <li>
          <span className="font-semibold">No written conflicts of interest policy</span> — Many
          smaller charities rely on informal understanding rather than documented procedures.
        </li>
        <li>
          <span className="font-semibold">Out-of-date governing document</span> — The constitution
          refers to structures or purposes that no longer reflect reality.
        </li>
        <li>
          <span className="font-semibold">No formal trustee induction</span> — New board members
          are given no structured introduction to their legal duties or the organisation's
          governance framework.
        </li>
        <li>
          <span className="font-semibold">No risk register</span> — Financial and reputational risks
          are managed informally in the chair's or treasurer's head rather than on paper.
        </li>
        <li>
          <span className="font-semibold">Late or incomplete Annual Reports</span> — Trustees are
          unaware of the legal filing deadline (10 months after the financial year end for most
          charities).
        </li>
      </ul>

      {/* Section 6 — How CharityPilot Helps */}
      <h2 className="text-2xl font-bold text-gray-900 mt-10 mb-4">
        How CharityPilot Can Help
      </h2>
      <p className="text-base leading-relaxed text-gray-700 mb-4">
        CharityPilot is built specifically around the structure of the Charities Governance Code.
        Every standard — all 49 of them — is mapped into the platform, so you always know exactly
        where you stand. The compliance dashboard gives your board a live view of which standards are
        met, which are partially met, and which still need work.
      </p>
      <p className="text-base leading-relaxed text-gray-700 mb-4">
        Beyond tracking, CharityPilot provides ready-to-use policy templates, a document library
        for storing evidence, automated reminders for annual filings, and a trustee portal that
        makes it easy to manage your conflicts of interest register, board minutes, and risk register
        in one place.
      </p>
      <p className="text-base leading-relaxed text-gray-700">
        Whether you are just getting to grips with the Code for the first time or you are a
        governance-confident organisation looking for a more efficient way to manage compliance,
        CharityPilot is designed to make the process straightforward — so your board can spend less
        time worrying about paperwork and more time advancing your charitable purpose.
      </p>
    </article>
  );
}
