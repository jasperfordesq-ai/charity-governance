import type { PostMeta } from '@/lib/blog';
import { CheckCircle2 } from 'lucide-react';

export const meta: PostMeta = {
  slug: 'essential-trustee-policies',
  title: 'The Eight Policies Every Irish Charity Board Must Have in Place',
  excerpt:
    'The Charities Governance Code requires your charity to have a range of written policies in place. Here are the eight most critical ones, what they must cover, and why they matter.',
  date: '2026-04-09',
  author: 'CharityPilot Team',
  category: 'Governance',
  readTime: '9 min read',
  tags: ['policies', 'trustees', 'governance', 'conflict of interest', 'safeguarding', 'complaints'],
};

export default function EssentialTrusteePolicies() {
  return (
    <article className="max-w-3xl mx-auto px-4 py-8 text-gray-800 dark:text-gray-100">

      {/* Intro */}
      <p className="text-lg leading-relaxed text-gray-700 dark:text-gray-300 mb-6">
        The Charities Governance Code — which applies to all registered charities in Ireland — is
        explicit: boards must have a suite of written policies that govern how the organisation
        operates. Policies are not bureaucratic paperwork for their own sake. They protect
        beneficiaries, protect trustees, reduce the risk of financial loss, and demonstrate to
        funders and the public that your charity is well managed.
      </p>
      <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300 mb-6">
        Yet many boards either have no written policies at all, or have adopted generic templates
        that were never properly reviewed or communicated to the people they apply to. Below are
        the eight policies that every Irish charity board should have in place — what each one
        must cover and why each one matters.
      </p>

      {/* Policy 1 */}
      <h2 className="text-2xl font-bold text-gray-900 dark:text-white mt-10 mb-4">
        1. Conflicts of Interest Policy
      </h2>
      <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300 mb-4">
        A conflict of interest arises when a trustee — or someone closely connected to them —
        stands to benefit personally from a decision the board is making. This covers financial
        conflicts (a trustee's company tendering for a contract), but also personal relationships,
        directorships in other organisations, and situations where a trustee's duty to the charity
        conflicts with their duty elsewhere.
      </p>
      <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300 mb-4">
        Your policy must define what constitutes a conflict, require trustees to declare interests
        at the start of each board meeting and whenever a relevant item arises, and specify the
        procedure when a conflict is declared — typically, the affected trustee leaves the room and
        takes no part in the discussion or vote. The policy should also establish a <strong>register
        of interests</strong>, updated at least annually, in which each trustee records their
        relevant roles, relationships, and financial interests.
      </p>
      <div className="border-l-4 border-teal-600 bg-teal-50 px-5 py-4 rounded-lg mb-6">
        <p className="text-sm text-teal-700 leading-relaxed">
          The register of interests is not simply a form to be completed and filed. The board chair
          should review it regularly, and it should be referenced at every board meeting before
          business begins.
        </p>
      </div>

      {/* Policy 2 */}
      <h2 className="text-2xl font-bold text-gray-900 dark:text-white mt-10 mb-4">
        2. Complaints Policy
      </h2>
      <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300 mb-4">
        Beneficiaries, service users, and members of the public must have a clear and accessible
        route to raise complaints about your charity's services, staff, or governance. A complaints
        policy sets out exactly how this works: how a complaint can be submitted (in writing, by
        phone, online), who receives it, the stages of investigation, and the timeframes at each
        stage.
      </p>
      <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300 mb-4">
        A well-designed complaints policy typically has two or three stages. The first stage
        involves an initial response and attempt at informal resolution, usually within five to ten
        working days. If the complainant remains dissatisfied, the complaint escalates to a formal
        investigation by a more senior person, with a written decision issued within a defined
        period — commonly 20 working days. A final stage may provide for review by the board chair
        or a sub-committee if the complainant is still not satisfied.
      </p>
      <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300 mb-4">
        Importantly, the policy should state how complaints data is logged and reported to the board.
        Trustees should receive a summary of complaints received, their nature, and their outcomes
        at regular intervals. Patterns in complaints can reveal systemic issues that need board
        attention.
      </p>

      {/* Policy 3 */}
      <h2 className="text-2xl font-bold text-gray-900 dark:text-white mt-10 mb-4">
        3. Safeguarding Policy
      </h2>
      <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300 mb-4">
        If your charity works with children, older people, or other vulnerable adults, a
        safeguarding policy is not optional — it is a legal and ethical imperative. Even charities
        that do not work directly with vulnerable groups should have a safeguarding framework in
        place, because activities can bring volunteers or staff into incidental contact with
        vulnerable individuals.
      </p>
      <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300 mb-4">
        The policy must identify a <strong>Designated Liaison Person</strong> (DLP) — the individual
        responsible for receiving and acting on safeguarding concerns. The DLP must be trained and
        supported to fulfil this role. The policy should also cover:
      </p>
      <ul className="list-none space-y-2 mb-4">
        {[
          'Vetting requirements — all staff and volunteers working with children must be Garda vetted under the National Vetting Bureau Acts 2012–2016; organisations working with vulnerable adults should have equivalent procedures',
          'What constitutes abuse (physical, emotional, sexual, neglect) and how to recognise indicators',
          'How to respond to a disclosure — listening, not promising confidentiality, reporting promptly',
          'Record-keeping requirements — what to document and how to store it securely',
          'How to escalate concerns to Tusla (the Child and Family Agency) or An Garda Síochána',
        ].map((item) => (
          <li key={item} className="flex gap-3">
            <CheckCircle2 className="mt-1 h-4 w-4 flex-shrink-0 text-teal-600" strokeWidth={1.75} aria-hidden="true" />
            <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300">{item}</p>
          </li>
        ))}
      </ul>
      <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300 mb-4">
        The policy should be reviewed at least annually by the board, and all staff and volunteers
        should receive safeguarding training appropriate to their role.
      </p>

      {/* Policy 4 */}
      <h2 className="text-2xl font-bold text-gray-900 dark:text-white mt-10 mb-4">
        4. Whistleblowing / Protected Disclosures Policy
      </h2>
      <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300 mb-4">
        The Protected Disclosures Act 2014 (as amended by the Protected Disclosures (Amendment) Act
        2022) gives significant legal protections to workers who report wrongdoing in good faith.
        Charities with five or more employees are required under the 2022 amendment to have a formal
        internal reporting channel and a written policy.
      </p>
      <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300 mb-4">
        The policy must explain what qualifies as a "protected disclosure" — broadly, a report of
        relevant wrongdoing including criminal offences, failure to comply with legal obligations,
        misuse of public funds, and threats to health and safety. It must identify who receives
        disclosures (a named "Responsible Person", typically a senior staff member or trustee),
        describe the process for investigating them, and set out the protections available to the
        person making the disclosure.
      </p>
      <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300 mb-4">
        Critically, the policy must make clear that penalising, dismissing, or otherwise
        disadvantaging a worker for making a protected disclosure in good faith is prohibited and
        gives rise to legal liability. Even charities not yet at the five-employee threshold should
        have a basic version of this policy in place — it signals a culture of accountability and
        provides a clear route for concerns to be heard.
      </p>

      {/* Policy 5 */}
      <h2 className="text-2xl font-bold text-gray-900 dark:text-white mt-10 mb-4">
        5. Data Protection Policy
      </h2>
      <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300 mb-4">
        GDPR applies to all Irish charities, regardless of size. A data protection policy must
        explain how personal data is collected, used, stored, and deleted, and it must be consistent
        with your charity's actual practices — not simply what you wish you did.
      </p>
      <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300 mb-4">
        The policy should cover:
      </p>
      <ul className="list-none space-y-2 mb-4">
        {[
          'The lawful basis for each category of personal data you process — consent, legitimate interests, contractual necessity, legal obligation, or vital interests',
          'How long different categories of data are retained, and the deletion or anonymisation procedure when retention periods expire',
          'Data subject rights — how individuals can request access to their data, correction, erasure, restriction, or portability, and your procedure for responding within the statutory one-month period',
          'Security measures — encryption, access controls, password policies, and what happens in the event of a data breach',
          'Whether your charity is required to appoint a Data Protection Officer (DPO) — mandatory only for certain types of large-scale processing, but advisable to consider for charities handling sensitive data such as health information or criminal records',
        ].map((item) => (
          <li key={item} className="flex gap-3">
            <CheckCircle2 className="mt-1 h-4 w-4 flex-shrink-0 text-teal-600" strokeWidth={1.75} aria-hidden="true" />
            <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300">{item}</p>
          </li>
        ))}
      </ul>
      <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300 mb-4">
        Data protection breaches can result in significant fines from the Data Protection Commission
        and, equally damaging, a loss of trust from the beneficiaries and donors who have shared
        their information with your charity.
      </p>

      {/* Policy 6 */}
      <h2 className="text-2xl font-bold text-gray-900 dark:text-white mt-10 mb-4">
        6. Financial Controls Policy
      </h2>
      <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300 mb-4">
        Financial controls are the internal procedures that prevent fraud, error, and
        misappropriation of charity funds. The Charities Governance Code requires charities to
        have adequate financial controls in place, and failure to do so is one of the most common
        findings when the CRA investigates governance failures.
      </p>
      <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300 mb-4">
        A financial controls policy should set out at minimum:
      </p>
      <ul className="list-none space-y-2 mb-6">
        {[
          'Authorisation limits — who can approve expenditure at each level (e.g., staff up to €500, CEO up to €5,000, board approval required above €10,000)',
          'Dual signatories — all payments above a defined threshold (typically €1,000–€2,500) require two authorised signatories, whether on cheques or bank transfers',
          'Expense claims — the process for staff and volunteer expenses, receipts required, maximum amounts, and who approves claims from senior staff',
          'Petty cash — maximum float, receipts for all disbursements, reconciliation frequency',
          'Bank reconciliation — how often accounts are reconciled to statements and who reviews the reconciliation',
          'Procurement — how contracts and significant purchases are tendered or justified',
        ].map((item) => (
          <li key={item} className="flex gap-3">
            <CheckCircle2 className="mt-1 h-4 w-4 flex-shrink-0 text-teal-600" strokeWidth={1.75} aria-hidden="true" />
            <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300">{item}</p>
          </li>
        ))}
      </ul>
      <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300 mb-4">
        One of the most effective controls is simply ensuring that no single person has end-to-end
        control over a financial transaction — from approving it, to processing it, to reconciling
        it in the accounts. Segregation of duties is a fundamental principle that applies even in
        very small charities with limited staff.
      </p>

      {/* Policy 7 */}
      <h2 className="text-2xl font-bold text-gray-900 dark:text-white mt-10 mb-4">
        7. Risk Management Policy
      </h2>
      <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300 mb-4">
        Every charity faces risks — to its finances, its reputation, its beneficiaries, its staff,
        and to the continuity of its activities. A risk management policy formalises how the board
        identifies, assesses, and responds to these risks.
      </p>
      <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300 mb-4">
        The policy should establish a <strong>risk register</strong> — a living document that lists
        each identified risk, assesses its likelihood and potential impact (typically on a 1–5
        scale for each, giving a combined risk score), assigns an owner, and records the controls
        or mitigations in place. The register should be reviewed by the board or a designated
        sub-committee at least twice a year, and updated whenever a significant new risk emerges.
      </p>
      <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300 mb-4">
        The policy should also address <strong>risk appetite</strong> — the level of risk the board
        is prepared to accept in pursuit of the charity's mission. This prevents the risk register
        from becoming a bureaucratic document that no one acts on. A charity working in emergency
        response may have a higher operational risk appetite than one managing a community
        building; the board needs to have an explicit conversation about where the boundaries are.
      </p>

      {/* Policy 8 */}
      <h2 className="text-2xl font-bold text-gray-900 dark:text-white mt-10 mb-4">
        8. Reserves Policy
      </h2>
      <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300 mb-4">
        A reserves policy explains why your charity holds a particular level of unrestricted
        reserves, how that level was calculated, and what the reserves are intended to protect
        against. It is required under the Charities Governance Code, and it is also scrutinised by
        funders who want to understand why a charity is accumulating funds rather than spending them
        on charitable purposes.
      </p>
      <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300 mb-4">
        There is no single correct level of reserves — it depends on your charity's circumstances.
        Relevant factors include:
      </p>
      <ul className="list-none space-y-2 mb-4">
        {[
          'Fixed commitments — staff salaries, lease obligations, and other costs that would continue even if income stopped suddenly',
          'Income volatility — charities that depend heavily on a small number of grants or a single major funder need larger reserves than those with diversified, predictable income streams',
          'Wind-down costs — how much it would cost to close the charity in an orderly way, including redundancy payments and contractual obligations',
          'Strategic opportunities — some charities deliberately hold reserves to be able to respond quickly to new opportunities or crises without waiting for grant funding',
        ].map((item) => (
          <li key={item} className="flex gap-3">
            <CheckCircle2 className="mt-1 h-4 w-4 flex-shrink-0 text-teal-600" strokeWidth={1.75} aria-hidden="true" />
            <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300">{item}</p>
          </li>
        ))}
      </ul>
      <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300 mb-4">
        A common starting-point calculation is three to six months of operating expenditure, but
        the board must be able to articulate why a specific figure is right for your charity — not
        simply cite a generic rule of thumb. The reserves policy should be reviewed annually and
        updated whenever circumstances change materially.
      </p>

      {/* Closing section */}
      <h2 className="text-2xl font-bold text-gray-900 dark:text-white mt-10 mb-4">
        Keeping Policies Accessible and Live
      </h2>
      <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300 mb-4">
        Having written policies is necessary but not sufficient. Policies that exist only in a
        filing cabinet or on a shared drive that no one can find are of limited value. For policies
        to work, trustees and staff must be aware of them, understand them, and know how to apply
        them.
      </p>
      <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300 mb-4">
        Best practice involves three things. First, store all policies in a <strong>central document
        vault</strong> where every trustee and relevant staff member can access the current version
        at any time. Second, include a review of key policies on your board's annual calendar —
        safeguarding, conflicts of interest, and risk management in particular should be formally
        reviewed by the full board at least once a year. Third, ensure that new trustees are given
        all relevant policies as part of their induction and have an opportunity to ask questions
        before they attend their first board meeting.
      </p>
      <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300 mb-4">
        The CRA may ask, during a compliance review, not just whether a policy exists but whether
        it has been reviewed recently, whether the board has read it, and whether it was followed
        in a specific instance. Being able to demonstrate all three — existence, review, and
        application — is the standard you should be aiming for.
      </p>

      {/* CharityPilot callout */}
      <div className="border-l-4 border-teal-600 bg-teal-50 px-5 py-4 rounded-lg mt-8 mb-6">
        <p className="text-sm font-semibold text-teal-800 mb-1">
          CharityPilot's Document Vault
        </p>
        <p className="text-sm text-teal-700 leading-relaxed">
          CharityPilot provides a centralised document vault where all eight of these policies —
          and your complete governance documentation — can be stored, versioned, and accessed by
          your trustees at any time. Review reminders are built in, so no policy falls out of date
          without the board noticing. New trustees get immediate access during onboarding, and the
          audit trail shows exactly who has read and acknowledged each document.
        </p>
      </div>

    </article>
  );
}
