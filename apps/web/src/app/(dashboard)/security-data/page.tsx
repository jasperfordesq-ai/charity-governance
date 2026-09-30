'use client';

import Link from 'next/link';
import { useAuth } from '@/lib/auth-context';
import { useDocumentTitle } from '@/lib/use-title';
import { AppPage, AppSection } from '@/components/ui/app-page';
import { PermissionHint } from '@/components/ui/states';
import { ReplayDiagnosticsPanel } from './replay-diagnostics-panel';
import { PersonalSecondFactorPanel } from './personal-second-factor-panel';
import { PersonalPasswordPanel } from './personal-password-panel';

const linkClass = 'font-medium text-teal-primary underline underline-offset-2';

export default function SecurityDataPage() {
  useDocumentTitle('Security & Data');
  const { user } = useAuth();
  const canReview = user?.role === 'OWNER' || user?.role === 'ADMIN';

  return (
    <AppPage
      eyebrow="Account & administration"
      title="Security & Data"
      description="Manage your sign-in security and find the charity's access, audit and data-request controls."
    >
      <PersonalSecondFactorPanel />
      <PersonalPasswordPanel />
      <AppSection title="Your sessions">
        <p className="text-sm text-gray-600 dark:text-gray-300">You can review and revoke your own active session families in Team & Permissions. Find your name and choose Manage sessions. Revoking the session you are using will sign you out.</p>
        <Link className={linkClass} href="/team">Manage your sessions</Link>
      </AppSection>
      {!canReview ? <PermissionHint>Only Owners and Admins can review charity-wide security, audit and data controls.</PermissionHint> : (
        <>
          <AppSection title="Access and account security">
            <ul className="grid gap-3 text-sm md:grid-cols-2">
              <li className="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
                <h3 className="font-semibold">Roles, invitations and sessions</h3>
                <p className="mt-1 text-gray-600 dark:text-gray-300">Review team access, active session families and revocation.</p>
                <Link className={linkClass} href="/team">Open Team</Link>
              </li>
              <li className="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
                <h3 className="font-semibold">Security & Ownership Audit</h3>
                <p className="mt-1 text-gray-600 dark:text-gray-300">Review sign-in, replay, refused action-approval, invitation and ownership events separately from record changes.</p>
                <Link className={linkClass} href="/team">Open security events in Team</Link>
              </li>
            </ul>
          </AppSection>

          <ReplayDiagnosticsPanel />

          <AppSection title="Governance and data lifecycle">
            <ul className="grid gap-3 text-sm md:grid-cols-2">
              <li className="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
                <h3 className="font-semibold">Governance and Vault access history</h3>
                <p className="mt-1 text-gray-600 dark:text-gray-300">Page through retained organisation, deadline, membership, document, risk, compliance and Minute Book changes, Vault download preparations, and human connector action approvals.</p>
                <Link className={linkClass} href="/governance-audit">Open Governance Audit</Link>
              </li>
              <li className="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
                <h3 className="font-semibold">Erasure and retention requests</h3>
                <p className="mt-1 text-gray-600 dark:text-gray-300">Record an opaque case reference, track assessment and link reviewed storage-deletion jobs. The queue does not perform deletion or assert completion.</p>
                <Link className={linkClass} href="/data-lifecycle">Open Data Requests</Link>
              </li>
              <li className="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
                <h3 className="font-semibold">Documents and storage deletion</h3>
                <p className="mt-1 text-gray-600 dark:text-gray-300">Review document visibility, lifecycle, deletion holds and failed storage-cleanup jobs. A confirmed cleanup retry is available for eligible jobs. Storage attempts appear in Governance Audit.</p>
                <Link className={linkClass} href="/documents">Open Documents</Link>
              </li>
              <li className="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
                <h3 className="font-semibold">Complaint recovery and retention</h3>
                <p className="mt-1 text-gray-600 dark:text-gray-300">Review complaint resolution evidence, administrative holds, approved class rules and recoverable complaints. Permanent complaint erasure is not available.</p>
                <Link className={linkClass} href="/registers">Open Registers</Link>
              </li>
              <li className="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
                <h3 className="font-semibold">Confluence copies</h3>
                <p className="mt-1 text-gray-600 dark:text-gray-300">Review the connected site and its separate copy-erasure workflow.</p>
                <Link className={linkClass} href="/integrations">Open Integrations</Link>
              </li>
            </ul>
          </AppSection>

          <AppSection title="Controls still being established">
            <p className="text-sm leading-6 text-gray-600 dark:text-gray-300">
              Administrative holds block Vault document and complaint removal, but are not legal-hold decisions.
              Recovery controls cover eligible Vault drafts and complaints under approved class rules.
              Vault draft disposal has a separate Owner review. Application-wide retention rules,
              legal holds, recovery for other record classes and permanent complaint erasure remain incomplete. A data request in the
              review queue does not establish that any database record, stored file, Confluence copy or
              backup has been erased.
            </p>
          </AppSection>
        </>
      )}
    </AppPage>
  );
}
