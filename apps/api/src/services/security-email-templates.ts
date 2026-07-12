// Security email template v1 is immutable. Provider idempotency requires every
// retry for one durable row to use byte-for-byte identical message content.
// Never edit the v1 renderers or their helpers after release; introduce a new
// row template version and retain this renderer for already-queued v1 rows.
export const SECURITY_EMAIL_TEMPLATE_VERSION = 1;

export type RenderedSecurityEmail = {
  subject: string;
  html: string;
  text: string;
};

const V1_BRAND_TEAL = '#0D7377';
const V1_BRAND_TEAL_LIGHT = '#e6f4f5';
const V1_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

function escapeHtmlV1(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildTokenUrlV1(frontendOrigin: string, token: string): string {
  const url = new URL('/reset-password', frontendOrigin);
  const fragmentParams = new URLSearchParams();
  fragmentParams.set('token', token);
  url.hash = fragmentParams.toString();
  return url.toString();
}

function emailLayoutV1(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtmlV1(title)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f6f8;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#f4f6f8;">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <table role="presentation" width="100%" style="max-width:600px;background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
          <tr>
            <td style="background-color:${V1_BRAND_TEAL};padding:32px 40px;">
              <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">CharityPilot</h1>
              <p style="margin:4px 0 0;color:rgba(255,255,255,0.8);font-size:13px;">Governance made simple for Irish charities</p>
            </td>
          </tr>
          <tr>
            <td style="padding:40px 40px 32px;">
              ${bodyHtml}
            </td>
          </tr>
          <tr>
            <td style="background-color:${V1_BRAND_TEAL_LIGHT};padding:24px 40px;border-top:1px solid #d1e9ea;">
              <p style="margin:0;color:#6b7280;font-size:12px;line-height:1.6;">
                You received this email because you have an account with CharityPilot.<br />
                &copy; CharityPilot. All rights reserved.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function h2V1(text: string): string {
  return `<h2 style="margin:0 0 16px;color:#111827;font-size:20px;font-weight:700;">${escapeHtmlV1(text)}</h2>`;
}

function paragraphV1(text: string): string {
  return `<p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.7;">${text}</p>`;
}

function smallNoteV1(text: string): string {
  return `<p style="margin:24px 0 0;color:#9ca3af;font-size:12px;line-height:1.6;">${escapeHtmlV1(text)}</p>`;
}

function primaryButtonV1(href: string, label: string): string {
  return `<a href="${escapeHtmlV1(href)}" style="display:inline-block;background-color:${V1_BRAND_TEAL};color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:14px 32px;border-radius:6px;margin-top:8px;">${escapeHtmlV1(label)}</a>`;
}

function changedAtLabelV1(changedAt: Date): string {
  if (!Number.isFinite(changedAt.getTime())) {
    throw new TypeError('Security email password-change time must be valid');
  }
  const day = changedAt.getUTCDate();
  const month = V1_MONTHS[changedAt.getUTCMonth()];
  const year = changedAt.getUTCFullYear();
  const hour = String(changedAt.getUTCHours()).padStart(2, '0');
  const minute = String(changedAt.getUTCMinutes()).padStart(2, '0');
  return `${day} ${month} ${year} at ${hour}:${minute}`;
}

export function renderPasswordRecoverySecurityEmailV1(input: {
  recipientName: string;
  token: string;
  frontendOrigin: string;
}): RenderedSecurityEmail {
  const resetUrl = buildTokenUrlV1(input.frontendOrigin, input.token);
  const subject = 'Reset your CharityPilot password';
  const body = `
      ${h2V1('Password reset request')}
      ${paragraphV1(`Hi ${escapeHtmlV1(input.recipientName)}, we received a request to reset the password for your CharityPilot account.`)}
      <div style="text-align:center;margin:32px 0;">
        ${primaryButtonV1(resetUrl, 'Reset Password')}
      </div>
      ${smallNoteV1('This link expires in 1 hour. If you did not request a password reset, you can safely ignore this email - your password will not change.')}
    `;
  const text = `Password reset request

Hi ${input.recipientName}, we received a request to reset the password for your CharityPilot account.

Reset your password:
${resetUrl}

This link expires in 1 hour. If you did not request a password reset, you can safely ignore this email - your password will not change.`;
  return { subject, html: emailLayoutV1(subject, body), text };
}

export function renderPasswordResetCompletedNoticeV1(input: {
  recipientName: string;
  changedAt: Date;
}): RenderedSecurityEmail {
  const subject = 'Your CharityPilot password was changed';
  const changedAtLabel = changedAtLabelV1(input.changedAt);
  const body = `
      ${h2V1('Your password was changed')}
      ${paragraphV1(`Hi ${escapeHtmlV1(input.recipientName)}, the password for your CharityPilot account was changed on <strong>${changedAtLabel} UTC</strong>.`)}
      ${paragraphV1('All existing CharityPilot sessions for your account were signed out as a security precaution.')}
      ${paragraphV1('If you made this change, no further action is needed. If you did not, request a new password reset from the CharityPilot sign-in page and contact an authorised organisation administrator immediately.')}
      ${smallNoteV1('CharityPilot will never send your password by email.')}
    `;
  const text = `Your password was changed

Hi ${input.recipientName}, the password for your CharityPilot account was changed on ${changedAtLabel} UTC.

All existing CharityPilot sessions for your account were signed out as a security precaution.

If you made this change, no further action is needed. If you did not, request a new password reset from the CharityPilot sign-in page and contact an authorised organisation administrator immediately.

CharityPilot will never send your password by email.`;
  return { subject, html: emailLayoutV1(subject, body), text };
}

export function renderPasswordRecoverySecurityEmail(
  templateVersion: number,
  input: Parameters<typeof renderPasswordRecoverySecurityEmailV1>[0],
): RenderedSecurityEmail {
  if (templateVersion === 1) return renderPasswordRecoverySecurityEmailV1(input);
  throw new TypeError(`Unsupported password recovery email template version: ${templateVersion}`);
}

export function renderPasswordResetCompletedNotice(
  templateVersion: number,
  input: Parameters<typeof renderPasswordResetCompletedNoticeV1>[0],
): RenderedSecurityEmail {
  if (templateVersion === 1) return renderPasswordResetCompletedNoticeV1(input);
  throw new TypeError(`Unsupported password reset notice template version: ${templateVersion}`);
}
