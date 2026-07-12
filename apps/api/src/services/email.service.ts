import { Resend, type CreateEmailRequestOptions } from 'resend';
import { isConfiguredSecret } from '../utils/env.js';
import { getPrimaryFrontendOrigin } from '../utils/frontend-origin.js';
import { formatProviderError } from '../utils/provider-errors.js';
import {
  renderPasswordRecoverySecurityEmail,
  renderPasswordResetCompletedNotice,
} from './security-email-templates.js';

const BRAND_TEAL = '#0D7377';
const BRAND_TEAL_LIGHT = '#e6f4f5';
const DEADLINE_REMINDER_PROVIDER_TIMEOUT_MS = 30 * 1000;
export const DEFAULT_SECURITY_EMAIL_PROVIDER_TIMEOUT_MS = 8 * 1000;
export const MIN_SECURITY_EMAIL_PROVIDER_TIMEOUT_MS = 1 * 1000;
export const MAX_SECURITY_EMAIL_PROVIDER_TIMEOUT_MS = 15 * 1000;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildTokenUrl(frontendUrl: string, path: string, token: string): string {
  const url = new URL(path, frontendUrl);
  const fragmentParams = new URLSearchParams();
  fragmentParams.set('token', token);
  url.hash = fragmentParams.toString();
  return url.toString();
}

function emailLayout(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
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

function primaryButton(href: string, label: string): string {
  return `<a href="${escapeHtml(href)}" style="display:inline-block;background-color:${BRAND_TEAL};color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:14px 32px;border-radius:6px;margin-top:8px;">${escapeHtml(label)}</a>`;
}

function h2(text: string): string {
  return `<h2 style="margin:0 0 16px;color:#111827;font-size:20px;font-weight:700;">${escapeHtml(text)}</h2>`;
}

function paragraph(text: string): string {
  return `<p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.7;">${text}</p>`;
}

function smallNote(text: string): string {
  return `<p style="margin:24px 0 0;color:#9ca3af;font-size:12px;line-height:1.6;">${escapeHtml(text)}</p>`;
}

function formatEmailDeliveryError(err: unknown): string {
  return formatProviderError(err);
}

type EmailLogger = {
  warn(message: string): void;
  error(message: string): void;
};

export type DeadlineReminderDeliveryResult =
  | { outcome: 'ACCEPTED'; providerMessageId: string }
  | { outcome: 'REJECTED' }
  | { outcome: 'UNCERTAIN' };

export type SecurityEmailDeliveryResult =
  | { outcome: 'ACCEPTED'; providerMessageId: string }
  | { outcome: 'REJECTED'; retryable: boolean }
  | { outcome: 'UNCERTAIN' };

export type SecurityEmailDeliveryOptions = {
  idempotencyKey: string;
  templateVersion: number;
  frontendOrigin?: string;
};

export function securityEmailProviderTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const configured = Number(env.SECURITY_EMAIL_PROVIDER_TIMEOUT_MS);
  return Number.isInteger(configured) &&
    configured >= MIN_SECURITY_EMAIL_PROVIDER_TIMEOUT_MS &&
    configured <= MAX_SECURITY_EMAIL_PROVIDER_TIMEOUT_MS
    ? configured
    : DEFAULT_SECURITY_EMAIL_PROVIDER_TIMEOUT_MS;
}

function providerErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { statusCode?: unknown; status?: unknown };
  const raw = candidate.statusCode ?? candidate.status;
  return typeof raw === 'number' && Number.isInteger(raw) ? raw : undefined;
}

function providerErrorName(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const name = (error as { name?: unknown }).name;
  return typeof name === 'string' ? name : undefined;
}

const silentEmailLogger: EmailLogger = {
  warn: () => undefined,
  error: () => undefined,
};

function defaultEmailLogger(): EmailLogger {
  return process.env.NODE_ENV === 'test' ? silentEmailLogger : console;
}

export class EmailService {
  private resend?: Resend;
  private from: string;
  private frontendUrl: string;
  private deadlineReminderProviderTimeoutMs: number;
  private securityEmailProviderTimeoutMs: number;

  constructor(
    private logger: EmailLogger = defaultEmailLogger(),
    deadlineReminderProviderTimeoutMs = DEADLINE_REMINDER_PROVIDER_TIMEOUT_MS,
    securityProviderTimeoutMs = securityEmailProviderTimeoutMs(),
  ) {
    if (!Number.isInteger(deadlineReminderProviderTimeoutMs) || deadlineReminderProviderTimeoutMs <= 0) {
      throw new TypeError('Deadline reminder provider timeout must be a positive integer');
    }
    if (
      !Number.isInteger(securityProviderTimeoutMs) ||
      securityProviderTimeoutMs <= 0 ||
      securityProviderTimeoutMs > MAX_SECURITY_EMAIL_PROVIDER_TIMEOUT_MS
    ) {
      throw new TypeError(
        `Security email provider timeout must be a positive integer no greater than ${MAX_SECURITY_EMAIL_PROVIDER_TIMEOUT_MS} milliseconds`,
      );
    }
    this.deadlineReminderProviderTimeoutMs = deadlineReminderProviderTimeoutMs;
    this.securityEmailProviderTimeoutMs = securityProviderTimeoutMs;
    this.resend = this.hasConfiguredResendKey() ? new Resend(process.env.RESEND_API_KEY) : undefined;
    this.from = process.env.EMAIL_FROM ?? 'noreply@charitypilot.ie';
    this.frontendUrl = getPrimaryFrontendOrigin();
  }

  private hasConfiguredResendKey(): boolean {
    return isConfiguredSecret(process.env.RESEND_API_KEY);
  }

  isConfigured(): boolean {
    return this.hasConfiguredResendKey() && this.from.includes('@') && this.resend !== undefined;
  }

  async sendWelcomeEmail(to: string, name: string, orgName: string): Promise<boolean> {
    const subject = `Welcome to CharityPilot, ${name}!`;
    const safeOrgName = escapeHtml(orgName);

    const body = `
      ${h2(`Welcome aboard, ${name}!`)}
      ${paragraph(`Thank you for registering <strong>${safeOrgName}</strong> on CharityPilot. We're delighted to have you.`)}
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

    return this._send(to, subject, emailLayout(subject, body));
  }

  async sendEmailVerification(to: string, name: string, token: string): Promise<boolean> {
    const verifyUrl = buildTokenUrl(this.frontendUrl, '/verify-email', token);
    const subject = 'Verify your CharityPilot email address';

    const body = `
      ${h2(`Hi ${name}, please verify your email`)}
      ${paragraph(`To complete your registration and keep your account secure, please verify your email address by clicking the button below.`)}
      <div style="text-align:center;margin:32px 0;">
        ${primaryButton(verifyUrl, 'Verify Email Address')}
      </div>
      ${smallNote(`This link expires in 24 hours. If you did not create a CharityPilot account, you can safely ignore this email.`)}
    `;

    return this._send(to, subject, emailLayout(subject, body));
  }

  async sendPasswordRecoveryEmail(
    to: string,
    name: string,
    token: string,
    options: SecurityEmailDeliveryOptions,
  ): Promise<SecurityEmailDeliveryResult> {
    const rendered = renderPasswordRecoverySecurityEmail(options.templateVersion, {
      recipientName: name,
      token,
      frontendOrigin: options.frontendOrigin ?? this.frontendUrl,
    });

    return this._sendSecurityEmail(
      to,
      rendered.subject,
      rendered.html,
      rendered.text,
      options,
      'password recovery',
    );
  }

  async sendPasswordResetCompletedNotice(
    to: string,
    name: string,
    changedAt: Date,
    options: SecurityEmailDeliveryOptions,
  ): Promise<SecurityEmailDeliveryResult> {
    const rendered = renderPasswordResetCompletedNotice(options.templateVersion, {
      recipientName: name,
      changedAt,
    });

    return this._sendSecurityEmail(
      to,
      rendered.subject,
      rendered.html,
      rendered.text,
      options,
      'password reset notice',
    );
  }

  async sendTeamInvite(
    to: string,
    orgName: string,
    invitedByName: string,
    token: string,
    role: string,
  ): Promise<boolean> {
    const inviteUrl = buildTokenUrl(this.frontendUrl, '/accept-invite', token);
    const subject = `${invitedByName} invited you to CharityPilot`;
    const safeInvitedByName = escapeHtml(invitedByName);
    const safeOrgName = escapeHtml(orgName);
    const safeRole = escapeHtml(role.toLowerCase());

    const body = `
      ${h2(`Join ${orgName} on CharityPilot`)}
      ${paragraph(`<strong>${safeInvitedByName}</strong> has invited you to help manage ${safeOrgName}'s governance workspace as a <strong>${safeRole}</strong>.`)}
      ${paragraph(`Use the secure invite link below to create your account and access the charity's compliance records, board evidence, deadlines, and governance registers.`)}
      <div style="text-align:center;margin:32px 0;">
        ${primaryButton(inviteUrl, 'Accept Invite')}
      </div>
      ${smallNote(`This invite expires in 7 days. If you were not expecting this invitation, you can safely ignore it.`)}
    `;

    return this._send(to, subject, emailLayout(subject, body));
  }

  async sendDeadlineReminder(
    to: string,
    orgName: string,
    deadline: { title: string; dueDate: Date; daysUntilDue: number },
    options: { idempotencyKey: string },
  ): Promise<DeadlineReminderDeliveryResult> {
    const { title, dueDate, daysUntilDue } = deadline;

    const urgencyColour = daysUntilDue <= 7 ? '#dc2626' : daysUntilDue <= 14 ? '#d97706' : BRAND_TEAL;
    const urgencyLabel =
      daysUntilDue <= 7 ? 'Urgent' : daysUntilDue <= 14 ? 'Coming up soon' : 'Reminder';

    const formattedDate = dueDate.toLocaleDateString('en-IE', {
      // The Date is an adapter for an exact Europe/Dublin civil date.
      // Day counts are computed by the scheduler before this rendering step;
      // UTC formatting prevents the Date adapter from shifting that civil date.
      timeZone: 'UTC',
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    const dayWord = daysUntilDue === 1 ? 'day' : 'days';
    const subject = `[${urgencyLabel}] Deadline in ${daysUntilDue} ${dayWord}: ${title}`;
    const safeOrgName = escapeHtml(orgName);
    const safeTitle = escapeHtml(title);
    const safeFormattedDate = escapeHtml(formattedDate);

    const body = `
      ${h2(`Governance deadline approaching`)}
      ${paragraph(`This is a reminder for <strong>${safeOrgName}</strong>. You have an upcoming deadline that requires your attention.`)}
      <table role="presentation" style="width:100%;background-color:${BRAND_TEAL_LIGHT};border-left:4px solid ${urgencyColour};border-radius:4px;padding:20px 24px;margin:24px 0;box-sizing:border-box;">
        <tr>
          <td>
            <p style="margin:0 0 8px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:${urgencyColour};">${urgencyLabel}</p>
            <p style="margin:0 0 4px;font-size:18px;font-weight:700;color:#111827;">${safeTitle}</p>
            <p style="margin:0;font-size:14px;color:#6b7280;">Due: ${safeFormattedDate} &mdash; <strong style="color:${urgencyColour};">${daysUntilDue} ${dayWord} remaining</strong></p>
          </td>
        </tr>
      </table>
      ${paragraph(`Log in to CharityPilot to review this deadline and mark it as complete once actioned.`)}
      <div style="margin-top:8px;">
        ${primaryButton(`${this.frontendUrl}/deadlines`, 'View Deadlines')}
      </div>
      ${smallNote(`You are receiving this reminder because you are the account owner for ${orgName} on CharityPilot. To adjust reminder settings, visit your dashboard.`)}
    `;

    return this._sendDeadlineReminder(to, subject, emailLayout(subject, body), options.idempotencyKey);
  }

  private async _sendDeadlineReminder(
    to: string,
    subject: string,
    html: string,
    idempotencyKey: string,
  ): Promise<DeadlineReminderDeliveryResult> {
    if (!this.isConfigured() || this.resend === undefined) {
      this.logger.warn('[EmailService] Deadline reminder not sent because delivery is not configured');
      return { outcome: 'REJECTED' };
    }

    const providerAbortController = new AbortController();
    const providerTimeout = setTimeout(() => {
      providerAbortController.abort(new Error('Deadline reminder provider request exceeded its bounded timeout'));
    }, this.deadlineReminderProviderTimeoutMs);

    try {
      // Resend 4.5.0 spreads its request options into the underlying fetch
      // RequestInit. Its public type currently exposes only idempotency metadata,
      // so retain the intersection here to pass an application-owned abort signal
      // without replacing the SDK or weakening the idempotency contract.
      const requestOptions: CreateEmailRequestOptions & { signal: AbortSignal } = {
        idempotencyKey,
        signal: providerAbortController.signal,
      };
      const response = await this.resend.emails.send(
        { from: this.from, to, subject, html },
        requestOptions,
      );
      if (response.error !== null) {
        this.logger.error(
          `[EmailService] Failed to send deadline reminder: ${formatEmailDeliveryError(response.error)}`,
        );
        const status = providerErrorStatus(response.error);
        const name = providerErrorName(response.error)?.toLowerCase();
        if (
          status === 409 ||
          status === 408 ||
          (status !== undefined && status >= 500) ||
          name === 'invalid_idempotent_request' ||
          name === 'concurrent_idempotent_requests'
        ) {
          return { outcome: 'UNCERTAIN' };
        }
        // Only an explicit, non-timeout 4xx response is treated as a definite
        // rejection. Unknown or changed SDK error shapes fail closed because
        // automatic retry after possible acceptance can duplicate delivery.
        if (status !== undefined && status >= 400 && status < 500) {
          return { outcome: 'REJECTED' };
        }
        return { outcome: 'UNCERTAIN' };
      }

      const acceptanceId = response.data?.id;
      if (typeof acceptanceId !== 'string' || acceptanceId.trim() === '') {
        this.logger.error(
          `[EmailService] Failed to send deadline reminder: ${formatEmailDeliveryError({
            name: 'InvalidProviderResponse',
            message: 'Email provider did not return an acceptance id',
          })}`,
        );
        return { outcome: 'UNCERTAIN' };
      }

      return { outcome: 'ACCEPTED', providerMessageId: acceptanceId };
    } catch (err) {
      this.logger.error(
        `[EmailService] Failed to send deadline reminder: ${formatEmailDeliveryError(err)}`,
      );
      return { outcome: 'UNCERTAIN' };
    } finally {
      clearTimeout(providerTimeout);
    }
  }

  private async _sendSecurityEmail(
    to: string,
    subject: string,
    html: string,
    text: string,
    options: SecurityEmailDeliveryOptions,
    messageKind: string,
  ): Promise<SecurityEmailDeliveryResult> {
    if (!options.idempotencyKey || options.idempotencyKey.length > 256) {
      throw new TypeError('Security email idempotency key must contain between 1 and 256 characters');
    }
    if (!this.isConfigured() || this.resend === undefined) {
      this.logger.warn(`[EmailService] ${messageKind} email not sent because delivery is not configured`);
      return { outcome: 'REJECTED', retryable: false };
    }

    const providerAbortController = new AbortController();
    let providerTimeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutOutcome = new Promise<never>((_resolve, reject) => {
      providerTimeout = setTimeout(() => {
        const timeoutError = new Error(
          'Security email provider request exceeded its bounded timeout',
        );
        providerAbortController.abort(timeoutError);
        reject(timeoutError);
      }, this.securityEmailProviderTimeoutMs);
    });

    try {
      const requestOptions: CreateEmailRequestOptions & { signal: AbortSignal } = {
        idempotencyKey: options.idempotencyKey,
        signal: providerAbortController.signal,
      };
      const response = await Promise.race([
        this.resend.emails.send(
          { from: this.from, to, subject, html, text },
          requestOptions,
        ),
        timeoutOutcome,
      ]);
      if (response.error !== null) {
        this.logger.error(
          `[EmailService] Failed to send ${messageKind} email: ${formatEmailDeliveryError(response.error)}`,
        );
        const status = providerErrorStatus(response.error);
        const name = providerErrorName(response.error)?.toLowerCase();
        if (
          status === 408 ||
          status === 409 ||
          (status !== undefined && status >= 500) ||
          name === 'invalid_idempotent_request' ||
          name === 'concurrent_idempotent_requests'
        ) {
          return { outcome: 'UNCERTAIN' };
        }
        if (status !== undefined && status >= 400 && status < 500) {
          return { outcome: 'REJECTED', retryable: status === 429 };
        }
        return { outcome: 'UNCERTAIN' };
      }

      const acceptanceId = response.data?.id;
      if (
        typeof acceptanceId !== 'string' ||
        acceptanceId.trim() === '' ||
        acceptanceId.length > 256
      ) {
        this.logger.error(
          `[EmailService] Failed to send ${messageKind} email: ${formatEmailDeliveryError({
            name: 'InvalidProviderResponse',
            message: 'Email provider did not return an acceptance id',
          })}`,
        );
        return { outcome: 'UNCERTAIN' };
      }

      return { outcome: 'ACCEPTED', providerMessageId: acceptanceId };
    } catch (err) {
      this.logger.error(
        `[EmailService] Failed to send ${messageKind} email: ${formatEmailDeliveryError(err)}`,
      );
      return { outcome: 'UNCERTAIN' };
    } finally {
      if (providerTimeout !== undefined) clearTimeout(providerTimeout);
    }
  }

  private async _send(
    to: string,
    subject: string,
    html: string,
    options: { idempotencyKey?: string } = {},
  ): Promise<boolean> {
    if (!this.isConfigured() || this.resend === undefined) {
      this.logger.warn('[EmailService] Email not sent because delivery is not configured');
      return false;
    }

    try {
      const payload = { from: this.from, to, subject, html };
      const response = options.idempotencyKey
        ? await this.resend.emails.send(payload, { idempotencyKey: options.idempotencyKey })
        : await this.resend.emails.send(payload);
      if (response.error !== null) {
        this.logger.error(`[EmailService] Failed to send email: ${formatEmailDeliveryError(response.error)}`);
        return false;
      }

      const acceptanceId = response.data?.id;
      if (typeof acceptanceId !== 'string' || acceptanceId.trim() === '') {
        this.logger.error(
          `[EmailService] Failed to send email: ${formatEmailDeliveryError({
            name: 'InvalidProviderResponse',
            message: 'Email provider did not return an acceptance id',
          })}`,
        );
        return false;
      }

      return true;
    } catch (err) {
      this.logger.error(`[EmailService] Failed to send email: ${formatEmailDeliveryError(err)}`);
      // Do not rethrow — email failure must not break the calling flow
      return false;
    }
  }
}
