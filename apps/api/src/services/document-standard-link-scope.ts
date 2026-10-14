/**
 * Which governance-standard links count for an organisation.
 *
 * Core standards only, unless the organisation is complex and on the Complete
 * plan. Kept in its own module so the documents register and the compliance
 * report scope linked evidence by one rule, without the report importing the
 * whole document service.
 */

export const standardLinkInclude = {
  include: { standard: { select: { id: true, code: true } } },
};

export const coreStandardLinkInclude = {
  where: { standard: { isCore: true } },
  include: { standard: { select: { id: true, code: true } } },
};

/** The link filter alone, for a query that selects its own fields. */
export function evidenceStandardLinkWhere(includeAdditionalStandards: boolean) {
  return includeAdditionalStandards ? {} : coreStandardLinkInclude.where;
}
