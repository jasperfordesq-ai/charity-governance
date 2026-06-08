-- Seed governance code reference data.
-- Keeps production migration-only deploys aligned with the app governance catalogue.

WITH principles(id, number, title, description, sort_order) AS (
  VALUES
    ('governance-principle-1', 1, 'Advancing Charitable Purpose', 'Charity trustees must ensure their charity promotes its charitable purpose only and that it is of public benefit.', 1),
    ('governance-principle-2', 2, 'Behaving with Integrity', 'Charity trustees have a legal duty to act in the best interests of the charity, independent of personal interests. They must lead by example and create an ethical culture.', 2),
    ('governance-principle-3', 3, 'Leading People', 'People should feel valued and have clarity around their own roles and the roles of others. Charity trustees are responsible for providing leadership to volunteers, employees and contractors.', 3),
    ('governance-principle-4', 4, 'Exercising Control', 'All charities must abide by all legal and regulatory requirements. The trustees are responsible for a charity''s funds and any property or other assets. They must also consider and reduce risks.', 4),
    ('governance-principle-5', 5, 'Working Effectively', 'Running a charity well means capable charity trustees who work together as an effective team. Board meetings are especially important. It is vital that new charity trustees receive a proper induction.', 5),
    ('governance-principle-6', 6, 'Being Accountable and Transparent', 'Accountability means being open and transparent about all charity matters — being able to stand over what your charity does and how it does it, and justify this to anyone who queries it.', 6)
)
INSERT INTO "GovernancePrinciple" ("id", "number", "title", "description", "sortOrder")
SELECT id, number, title, description, sort_order
FROM principles
ON CONFLICT ("number") DO UPDATE SET
  "title" = EXCLUDED."title",
  "description" = EXCLUDED."description",
  "sortOrder" = EXCLUDED."sortOrder";

WITH standards(id, principle_number, code, title, is_core, is_additional, sort_order) AS (
  VALUES
    ('governance-standard-1-1', 1, '1.1', 'Be clear about the purpose of your charity and be able to explain this in simple terms to anyone who asks.', true, false, 1),
    ('governance-standard-1-2', 1, '1.2', 'Consider whether or not any private benefit arises. If a private benefit arises, consider if it is reasonable, necessary and ancillary to the public benefit that your charity provides.', true, false, 2),
    ('governance-standard-1-3', 1, '1.3', 'Agree an achievable plan for at least the next year that sets out what you will do to advance your purpose.', true, false, 3),
    ('governance-standard-1-4', 1, '1.4', 'Make sure your charity has the resources it needs to do the activities you plan. If you don''t have the resources, you need to show a plan for getting those resources.', true, false, 4),
    ('governance-standard-1-5', 1, '1.5', 'From time to time, review what you are doing to make sure you are still: acting in line with your charity''s purpose; and providing public benefit.', true, false, 5),
    ('governance-standard-1-6', 1, '1.6', 'Develop your charity''s strategic plan and associated operational plans.', false, true, 6),
    ('governance-standard-1-7', 1, '1.7', 'Make sure there is an appropriate system in place to: monitor progress against your plans; and evaluate the effectiveness of the work of your charity.', false, true, 7),
    ('governance-standard-1-8', 1, '1.8', 'From time to time, consider the advantages and disadvantages of working in partnership with other charities, including merging or dissolving (winding up).', false, true, 8),
    ('governance-standard-2-1', 2, '2.1', 'Agree the basic values that matter to your charity and publicise these, so that everyone involved understands the way things should be done and how everyone is expected to behave.', true, false, 9),
    ('governance-standard-2-2', 2, '2.2', 'Decide how you will deal with conflicts of interests and conflicts of loyalties. You should also decide how you will adhere to the Charities Regulator''s guidelines on this topic.', true, false, 10),
    ('governance-standard-2-3', 2, '2.3', 'Have a code of conduct for your board that is signed by all charity trustees. It must make clear the standard of behaviour expected from charity trustees. This includes things like maintaining board confidentiality and what to do in relation to: gifts and hospitality; and out-of-pocket expenses.', true, false, 11),
    ('governance-standard-3-1', 3, '3.1', 'Be clear about the roles of everyone working in and for your charity, both on a voluntary and paid basis.', true, false, 12),
    ('governance-standard-3-2', 3, '3.2', 'Make sure there are arrangements in place for the effective involvement of any volunteers, including what to do if any problems arise.', true, false, 13),
    ('governance-standard-3-3', 3, '3.3', 'Make sure there are arrangements in place that comply with employment legislation for all paid staff including: recruitment; training and development; support, supervision and appraisal; remuneration and dismissal.', true, false, 14),
    ('governance-standard-3-4', 3, '3.4', 'Agree operational policies where necessary, to guide the actions of everyone involved in your charity.', true, false, 15),
    ('governance-standard-3-5', 3, '3.5', 'Make sure to document the roles, legal duties and delegated responsibility for decision-making of: individual charity trustees and the board as a whole; any sub-committees or working groups; staff and volunteers.', false, true, 16),
    ('governance-standard-3-6', 3, '3.6', 'Make sure that there are written procedures in place which set out how volunteers are: recruited, supported and supervised while within your charity; and the conditions under which they exit.', false, true, 17),
    ('governance-standard-3-7', 3, '3.7', 'Decide how you will develop operational policy in your charity. You also need to decide how your charity trustees will make sure that policy is put in place and kept up to date.', false, true, 18),
    ('governance-standard-4-1', 4, '4.1', 'Decide if your charity''s current legal form and governing document are fit for purpose. Make changes if necessary, telling the Charities Regulator in advance that you are doing so.', true, false, 19),
    ('governance-standard-4-2', 4, '4.2', 'Find out the laws and regulatory requirements that are relevant to your charity and comply with them.', true, false, 20),
    ('governance-standard-4-3', 4, '4.3', 'If your charity raises funds from the public, read the Charities Regulator''s guidelines on this topic and make sure that your charity adheres to them as they apply to your charity.', true, false, 21),
    ('governance-standard-4-4', 4, '4.4', 'Make sure you have appropriate financial controls in place to manage and account for your charity''s money and other assets.', true, false, 22),
    ('governance-standard-4-5', 4, '4.5', 'Identify any risks your charity might face and how to manage these.', true, false, 23),
    ('governance-standard-4-6', 4, '4.6', 'Make sure your charity has appropriate and adequate insurance cover.', true, false, 24),
    ('governance-standard-4-7', 4, '4.7', 'Have written procedures to make sure that you comply with all relevant legal and regulatory requirements.', false, true, 25),
    ('governance-standard-4-8', 4, '4.8', 'Make sure there is a formal risk register that your board regularly reviews.', false, true, 26),
    ('governance-standard-4-9', 4, '4.9', 'Consider adopting additional good practice standards that are relevant to the particular work that your charity does.', false, true, 27),
    ('governance-standard-5-1', 5, '5.1', 'Identify charity trustees with the necessary skills to undertake: any designated roles set out in your governing document; and other roles as appropriate within the board.', true, false, 28),
    ('governance-standard-5-2', 5, '5.2', 'Hold regular board meetings. Give enough notice before meetings and provide prepared agendas.', true, false, 29),
    ('governance-standard-5-3', 5, '5.3', 'At a minimum, your board agendas should always include these items: reporting on activities; review of finances; and conflicts of interests and loyalties.', true, false, 30),
    ('governance-standard-5-4', 5, '5.4', 'Make sure that your charity trustees have the facts to make informed decisions at board meetings and that these decisions are recorded accurately in the minutes.', true, false, 31),
    ('governance-standard-5-5', 5, '5.5', 'Consider introducing term limits for your charity trustees, with a suggested maximum of nine years in total.', true, false, 32),
    ('governance-standard-5-6', 5, '5.6', 'Recruit suitable new charity trustees as necessary and make sure that they receive an induction.', true, false, 33),
    ('governance-standard-5-7', 5, '5.7', 'Make sure all of your trustees understand: their role as charity trustees; the charity''s governing document; and this Code.', true, false, 34),
    ('governance-standard-5-8', 5, '5.8', 'Commit to resolving problems and emerging issues as quickly as possible and in the best interests of your charity.', true, false, 35),
    ('governance-standard-5-9', 5, '5.9', 'From time to time, review how your board operates and make any necessary improvements.', true, false, 36),
    ('governance-standard-5-10', 5, '5.10', 'Make sure you send out board packs with enough notice and include all relevant reports and explanatory papers to enable informed decision-making.', false, true, 37),
    ('governance-standard-5-11', 5, '5.11', 'Make sure that you have a charity trustee succession plan in place and consider how you can maximise diversity among your charity trustees.', false, true, 38),
    ('governance-standard-5-12', 5, '5.12', 'Put in place a comprehensive induction programme for new charity trustees.', false, true, 39),
    ('governance-standard-5-13', 5, '5.13', 'Conduct a regular review that includes an assessment of: the effectiveness of your board as a whole, office holders and individual charity trustees; adherence to the board code of conduct; and the structure, size, membership and terms of reference of any sub-committees.', false, true, 40),
    ('governance-standard-5-14', 5, '5.14', 'Do regular skills audits and provide appropriate training and development to charity trustees. If necessary, recruit to fill any competency gaps on the board of your charity.', false, true, 41),
    ('governance-standard-6-1', 6, '6.1', 'Make sure that the name and Registered Charity Number (RCN) of your charity is displayed on all of your written materials, including your: website; social media platforms; and email communications.', true, false, 42),
    ('governance-standard-6-2', 6, '6.2', 'Identify your stakeholders and decide how you will communicate with them.', true, false, 43),
    ('governance-standard-6-3', 6, '6.3', 'Decide if and how you will involve your stakeholders in your: planning; decision-making; and review processes.', true, false, 44),
    ('governance-standard-6-4', 6, '6.4', 'Make sure you have a procedure for dealing with: queries; comments; and complaints.', true, false, 45),
    ('governance-standard-6-5', 6, '6.5', 'Follow the reporting requirements of all of your funders and donors, both public and private.', true, false, 46),
    ('governance-standard-6-6', 6, '6.6', 'Produce unabridged (full) financial accounts and make sure that these and your charity''s annual report are widely available and easy for everyone to access.', false, true, 47),
    ('governance-standard-6-7', 6, '6.7', 'Make sure all the codes and standards of practice to which your charity subscribes are publicly stated.', false, true, 48),
    ('governance-standard-6-8', 6, '6.8', 'Regularly review any complaints your charity receives and take action to improve organisational practice.', false, true, 49)
)
INSERT INTO "GovernanceStandard" ("id", "principleId", "code", "title", "isCore", "isAdditional", "sortOrder")
SELECT
  standards.id,
  principles."id",
  standards.code,
  standards.title,
  standards.is_core,
  standards.is_additional,
  standards.sort_order
FROM standards
JOIN "GovernancePrinciple" principles
  ON principles."number" = standards.principle_number
ON CONFLICT ("code") DO UPDATE SET
  "principleId" = EXCLUDED."principleId",
  "title" = EXCLUDED."title",
  "isCore" = EXCLUDED."isCore",
  "isAdditional" = EXCLUDED."isAdditional",
  "sortOrder" = EXCLUDED."sortOrder";
