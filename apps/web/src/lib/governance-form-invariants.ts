import { AnnualReportFilingStatus } from '@charitypilot/shared';

type OptionalDate = string | null | undefined;

function normalizedDate(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function boardMemberFormInvariantReason({
  appointedDate,
  termEndDate,
  conductSigned,
  conductSignedDate,
  inductionCompleted,
  inductionDate,
}: {
  appointedDate: OptionalDate;
  termEndDate: OptionalDate;
  conductSigned: boolean;
  conductSignedDate: OptionalDate;
  inductionCompleted: boolean;
  inductionDate: OptionalDate;
}): string {
  const appointed = normalizedDate(appointedDate);
  const termEnd = normalizedDate(termEndDate);

  if (appointed && termEnd && termEnd < appointed) {
    return 'Set the term end date on or after the appointment date.';
  }
  if (conductSigned && !normalizedDate(conductSignedDate)) {
    return 'Add the conduct signing date before marking the code of conduct as signed.';
  }
  if (inductionCompleted && !normalizedDate(inductionDate)) {
    return 'Add the induction date before marking induction as completed.';
  }
  return '';
}

export function fundraisingFormInvariantReason(startDate: unknown, endDate: unknown): string {
  const start = normalizedDate(startDate);
  const end = normalizedDate(endDate);

  if (start && end && end < start) {
    return 'Set the fundraising end date on or after the start date.';
  }
  return '';
}

export function annualReportFilingInvariantReason(
  filingStatus: AnnualReportFilingStatus,
  filedDate: OptionalDate,
): string {
  if (filingStatus === AnnualReportFilingStatus.FILED && !normalizedDate(filedDate)) {
    return 'Add the filed date before saving an Annual Report status of Filed.';
  }
  return '';
}
