import { Resend } from 'resend';

const BRAND_TEAL = '#0D7377';
const BRAND_TEAL_LIGHT = '#e6f4f5';

function emailLayout(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f6f8;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#f4f6f8;">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <table role="presentation" width="100%" style="max-width:600px;background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
          <!-- Header -->
          <tr>
            <td style="background-color:${BRAND_TEAL};padding:32px 40px;">
              <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">CharityPilot</h1>
              <p style="margin:4px 0 0;color:rgba(255,255,255,0.8);font-size:13px;">Governance made simple for Irish charities</p>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:40px 40px 32px;">
              ${bodyHtml}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background-color:${BRAND_TEAL_LIGHT};padding:24px 40px;border-top:1px solid #d1e9ea;">
              <p style="margin:0;color:#6b7280;font-size:12px;line-height:1.6;">
                You received this email because you have an account with CharityPilot.<br />
                &copy; ${new Date().getFullYear()} CharityPilot. All rights reserved.
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

function primaryButton(href: string, label: string): string {
  return `<a href="${href}" style="display:inline-block;background-color:${BRAND_TEAL};color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:14px 32px;border-radius:6px;margin-top:8px;">${label}</a>`;
}

function h2(text: string): string {
  return `<h2 style="margin:0 0 16px;color:#111827;font-size:20px;font-weight:700;">${text}</h2>`;
}

function paragraph(text: string): string {
  return `<p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.7;">${text}</p>`;
}

function smallNote(text: string): string {
  return `<p style="margin:24px 0 0;color:#9ca3af;font-size:12px;line-height:1.6;">${text}</p>`;
}

export class EmailService {
  private resend: Resend;
  private from: string;
  private frontendUrl: string;

  constructor() {
    this.resend = new Resend(process.env.RESEND_API_KEY);
    this.from = process.env.EMAIL_FROM ?? 'noreply@charitypilot.ie';
    this.frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3000';
  }

  async sendWelcomeEmail(to: string, name: string, orgName: string): Promise<void> {
    const subject = `Welcome to CharityPilot, ${name}!`;

    const body = `
      ${h2(`Welcome aboard, ${name}!`)}
      ${paragraph(`Thank you for registering <strong>${orgName}</strong> on CharityPilot. We're delighted to have you.`)}
      ${paragraph(`Your <strong>14-day free trial</strong> has started. During your trial you have full access to all features — compliance tracking, deadline management, document storage, and more.`)}
      <table role="presentation" style="background-color:${BRAND_TEAL_LIGHT};border-left:4px solid ${BRAND_TEAL};border-radius:4px;padding:16px 20px;margin:24px 0;width:100%;box-sizing:border-box;">
        <tr>
          <td>
            <p style="margin:0;color:#0a5c60;font-size:14px;font-weight:600;">What's next?</p>
            <ul style="margin:8px 0 0;padding-left:20px;color:#374151;font-size:14px;line-height:1.8;">
              <li>Complete your organisation profile</li>
              <li>Run your first compliance check</li>
              <li>Set up upcoming governance deadlines</li>
            </ul>
          </td>
        </tr>
      </table>
      <div style="margin-top:8px;">
        ${primaryButton(`${this.frontendUrl}/dashboard`, 'Go to Dashboard')}
      </div>
      ${smallNote(`If you did not create this account, please ignore this email or contact us at support@charitypilot.ie.`)}
    `;

    await this._send(to, subject, emailLayout(subject, body));
  }

  async sendEmailVerification(to: string, name: string, token: string): Promise<void> {
    const verifyUrl = `${this.frontendUrl}/verify-email?token=${token}`;
    const subject = 'Verify your CharityPilot email address';

    const body = `
      ${h2(`Hi ${name}, please verify your email`)}
      ${paragraph(`To complete your registration and keep your account secure, please verify your email address by clicking the button below.`)}
      <div style="text-align:center;margin:32px 0;">
        ${primaryButton(verifyUrl, 'Verify Email Address')}
      </div>
      ${paragraph(`Or paste this link into your browser:`)}
      <p style="word-break:break-all;background-color:${BRAND_TEAL_LIGHT};padding:12px 16px;border-radius:4px;font-size:13px;color:#0a5c60;margin:0 0 16px;">${verifyUrl}</p>
      ${smallNote(`This link expires in 24 hours. If you did not create a CharityPilot account, you can safely ignore this email.`)}
    `;

    await this._send(to, subject, emailLayout(subject, body));
  }

  async sendPasswordReset(to: string, name: string, token: string): Promise<void> {
    const resetUrl = `${this.frontendUrl}/reset-password?token=${token}`;
    const subject = 'Reset your CharityPilot password';

    const body = `
      ${h2(`Password reset request`)}
      ${paragraph(`Hi ${name}, we received a request to reset the password for your CharityPilot account.`)}
      <div style="text-align:center;margin:32px 0;">
        ${primaryButton(resetUrl, 'Reset Password')}
      </div>
      ${paragraph(`Or paste this link into your browser:`)}
      <p style="word-break:break-all;background-color:${BRAND_TEAL_LIGHT};padding:12px 16px;border-radius:4px;font-size:13px;color:#0a5c60;margin:0 0 16px;">${resetUrl}</p>
      ${smallNote(`This link expires in 1 hour. If you did not request a password reset, you can safely ignore this email — your password will not change.`)}
    `;

    await this._send(to, subject, emailLayout(subject, body));
  }

  async sendDeadlineReminder(
    to: string,
    orgName: string,
    deadline: { title: string; dueDate: Date; daysUntilDue: number },
  ): Promise<void> {
    const { title, dueDate, daysUntilDue } = deadline;

    const urgencyColour = daysUntilDue <= 7 ? '#dc2626' : daysUntilDue <= 14 ? '#d97706' : BRAND_TEAL;
    const urgencyLabel =
      daysUntilDue <= 7 ? 'Urgent' : daysUntilDue <= 14 ? 'Coming up soon' : 'Reminder';

    const formattedDate = dueDate.toLocaleDateString('en-IE', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    const dayWord = daysUntilDue === 1 ? 'day' : 'days';
    const subject = `[${urgencyLabel}] Deadline in ${daysUntilDue} ${dayWord}: ${title}`;

    const body = `
      ${h2(`Governance deadline approaching`)}
      ${paragraph(`This is a reminder for <strong>${orgName}</strong>. You have an upcoming deadline that requires your attention.`)}
      <table role="presentation" style="width:100%;background-color:${BRAND_TEAL_LIGHT};border-left:4px solid ${urgencyColour};border-radius:4px;padding:20px 24px;margin:24px 0;box-sizing:border-box;">
        <tr>
          <td>
            <p style="margin:0 0 8px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:${urgencyColour};">${urgencyLabel}</p>
            <p style="margin:0 0 4px;font-size:18px;font-weight:700;color:#111827;">${title}</p>
            <p style="margin:0;font-size:14px;color:#6b7280;">Due: ${formattedDate} &mdash; <strong style="color:${urgencyColour};">${daysUntilDue} ${dayWord} remaining</strong></p>
          </td>
        </tr>
      </table>
      ${paragraph(`Log in to CharityPilot to review this deadline and mark it as complete once actioned.`)}
      <div style="margin-top:8px;">
        ${primaryButton(`${this.frontendUrl}/dashboard/deadlines`, 'View Deadlines')}
      </div>
      ${smallNote(`You are receiving this reminder because you are the account owner for ${orgName} on CharityPilot. To adjust reminder settings, visit your dashboard.`)}
    `;

    await this._send(to, subject, emailLayout(subject, body));
  }

  private async _send(to: string, subject: string, html: string): Promise<void> {
    try {
      await this.resend.emails.send({ from: this.from, to, subject, html });
    } catch (err) {
      console.error(`[EmailService] Failed to send "${subject}" to ${to}:`, err);
      // Do not rethrow — email failure must not break the calling flow
    }
  }
}
