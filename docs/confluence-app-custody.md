# Confluence application ownership and key custody

This operating decision supports the optional Confluence connector. It does not
select a hosting supplier, grant provider access or certify an organisation's
current arrangements. Record exact app/site/account identities and observations
in the ignored private evidence register.

## Distinct authorities

| Authority | What to verify |
| --- | --- |
| OAuth app owner and contributors | Named owner, actual contributor roles, permitted ownership transfer and loss-of-owner recovery. Site administration alone is insufficient evidence of app administration. |
| Confluence site and space | Which site/resource the user consented to, current space restrictions and the consenting account's permissions. App contributor status does not establish site access. |
| Runtime credentials | Recorded granted scopes and connection generation, sealed credential storage, root-key custodian and supported rotation procedure. Configured app scopes are not evidence of a particular user's current grant. |
| Independent recovery | Separately administered encrypted recovery material, separately held usable keys, current decision history and actual restoration after loss of the original account/host. Two local credential rows do not prove this. |

Atlassian's [19 March 2026 OAuth changelog](https://developer.atlassian.com/cloud/oauth/changelog/)
confirms multiple administrators and ownership transfer for OAuth 2.0 apps in the
developer console. A Forge rewrite is not required to obtain that capability.
Verify the actual OAuth app's current controls; Forge-specific role descriptions
are not sufficient evidence of the permissions available to that OAuth app.

## Operating decision

For operational reliance, establish a named accountable app owner and a named
backup operator with individually authenticated, least necessary app access.
Verify the backup operator's supported administration/recovery journey and record
its limits before relying on it. Preserve separate sandbox and production
identities and avoid cross-site consent as a recovery shortcut.

A sole-owner synthetic app may continue supervised tests with synthetic data;
that arrangement makes no independent operator-continuity claim. Observations
about this test app do not establish ownership or recovery of a production app.

Assigning a contributor, transferring ownership, changing scopes/callbacks,
moving credentials or granting another site requires specific authority. A
read-only custody inspection and this operating decision do not grant it.
Keep secrets out of screenshots, logs, tracked documents and review receipts.

## Review and activation sequence

1. Read the exact app's Overview, Contributors, Permissions and Authorization
   pages. Record loading-complete values; temporary empty tables are not absence.
   Inspect callback registration without following a generated authorization URL.
2. Compare configured API scopes with the application's requested scopes and
   recorded grant. `offline_access` is a refresh capability, separate from the
   configured Confluence API scope count. It does not authorise purposeless
   refresh or expand the site's consent boundary.
3. Identify the proposed backup operator, exact app role and operational purpose.
   Obtain action-time authority before the access change, then use the supported
   contributor workflow. Verify the recipient's actual resulting access and
   retain the outcome independently of the original operator's account.
4. Record where the app secret, integration encryption key and recovery material
   are held using identifiers only. Follow the current deployment runbook and
   the integration-key rotation workflow in [ARCHITECTURE.md](ARCHITECTURE.md).
   Key custody is incomplete until restoration has been proved in the selected
   independent failure domain under the supported recovery controls.
5. Preserve separate receipts for local disconnect/credential destruction and
   upstream revocation. A developer-console contributor list proves neither;
   a successful revocation endpoint response alone does not prove the user's
   upstream grant is absent.

## Evidence boundary

The 19 October read-only inspection establishes the synthetic app's resource-level
type, sole Owner/Admin contributor, eight configured granular Confluence API
scopes and local callback. The synthetic application independently records those
eight scopes plus `offline_access`, one connected integration and two sealed
credential rows. No secret was inspected or rotated, contributor added, ownership
transferred, callback/scope changed, app disconnected or grant revoked. Independent
key custody, backup-operator recovery and the production app remain unverified.
Exact identities and screenshots are private; use the current continuation handoff.
