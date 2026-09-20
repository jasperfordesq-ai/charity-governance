/**
 * Mutating API routes the connector deliberately does not expose, each with the
 * reason it is left out.
 *
 * The companion of `route-coverage.ts`, and it exists for the same reason. That
 * one has stopped readable routes from quietly falling behind the API since the
 * connector was read-only. This one did not exist when writes were added, and
 * the omission showed: four register update routes, the compliance sign-off,
 * the annual report, voiding a governing act and — most visibly — changing the
 * organisation profile all went missing without anybody noticing, because
 * nothing required the choice to be made.
 *
 * The rule the test enforces: every route the API registers with an unsafe
 * method is either a connector tool or an entry here with a reason.
 */
export interface ExcludedMutation {
  /** `METHOD /api/v1/...`, the path exactly as the route registers it. */
  route: string;
  reason: string;
  /**
   * True when the route is not registered in its group's `index.ts` — it lives
   * in a sibling file, or only under some deployment profiles. The coverage
   * test cannot discover these, so it does not treat them as stale.
   */
  notInGroupIndex?: boolean;
}

export const EXCLUDED_MUTATIONS: readonly ExcludedMutation[] = [
  /* --- the platform operator realm ------------------------------------- */
  {
    route: 'POST /api/v1/owner/auth/login',
    reason:
      'The platform operator realm: a separate credential, a separate cookie scope, and not a '
      + 'charity login at all. A connector that could sign in here would not be acting as the '
      + 'person running it.',
    notInGroupIndex: true,
  },
  {
    route: 'POST /api/v1/owner/auth/refresh',
    reason: 'Operator session rotation, with the same reasoning.',
    notInGroupIndex: true,
  },
  {
    route: 'POST /api/v1/owner/auth/logout',
    reason: 'Operator session revocation, with the same reasoning.',
    notInGroupIndex: true,
  },
  {
    route: 'POST /api/v1/owner/auth/set-password',
    reason:
      'Sets a platform operator password from a one-time link. Nothing that sets a password '
      + 'belongs in a connector.',
    notInGroupIndex: true,
  },
  {
    route: 'POST /api/v1/owner/auth/second-factor/begin',
    reason:
      'Starts enrolling a second factor on a platform operator account, and hands back the '
      + 'shared secret. A connector that could call it would be a connector that could clone '
      + 'the factor protecting the console.',
    notInGroupIndex: true,
  },
  {
    route: 'POST /api/v1/owner/auth/second-factor/complete',
    reason:
      'Turns a second factor on and returns the recovery codes. Operator credentials are not '
      + 'a charity connector’s business in either direction.',
    notInGroupIndex: true,
  },
  {
    route: 'POST /api/v1/owner/auth/second-factor/remove',
    reason:
      'Takes a second factor off a platform operator account. Removing the protection on the '
      + 'console is the last thing that should ever be reachable from a tool.',
    notInGroupIndex: true,
  },
  {
    route: 'POST /api/v1/owner/tenants',
    reason:
      'Creates a charity on the platform. Cross-tenant by definition; a connector that can '
      + 'reach it is no longer single-tenant.',
    notInGroupIndex: true,
  },
  {
    route: 'PATCH /api/v1/owner/tenants/:id/configuration',
    reason:
      'Sets another charity’s document storage provider, alpha opt-in and plan. Decided by '
      + 'a platform operator on the charity’s behalf, which is a different authority from '
      + 'the one a connector holds; a charity changes what it can change through its own '
      + 'settings.',
    notInGroupIndex: true,
  },
  {
    route: 'POST /api/v1/owner/tenants/:id/lifecycle',
    reason: 'Suspends or closes a whole charity. Cross-tenant, with the same reasoning.',
    notInGroupIndex: true,
  },

  /* --- team membership and ownership ------------------------------------ */
  {
    route: 'POST /api/v1/team/invites/:id/link',
    reason:
      'Answers with the one-time invite link itself, which is a credential to join the '
      + 'charity. Creating an invite is offered (the connector drops the link from that '
      + 'response); fetching the link back exists only to put it in front of a person.',
  },
  {
    route: 'POST /api/v1/team/accept-invite',
    reason:
      'Accepts an invite as the invited person. It is the other half of a sign-up flow and '
      + 'has no meaning for an already signed-in connector.',
  },
  {
    route: 'POST /api/v1/team/ownership/transfer',
    reason:
      'Hands the charity to somebody else. It signs the current owner out as it goes and '
      + 'requires a typed confirmation string, so it is not a thing to do through an '
      + 'intermediary. The other access decisions are offered, because the API gates each of '
      + 'them with an administrator session and a per-action approval.',
  },

  /* --- billing ----------------------------------------------------------- */
  {
    route: 'POST /api/v1/billing/checkout',
    reason:
      'Starts a payment. It redirects to a payment provider and ends in somebody entering card '
      + 'details, which is not something a connector should be arranging.',
  },
  {
    route: 'POST /api/v1/billing/create-checkout',
    reason:
      'The same flow under an older name, kept for compatibility. Excluded for the same '
      + 'reason as the name that replaced it.',
  },
  {
    route: 'POST /api/v1/billing/portal',
    reason:
      'Opens the payment provider’s own management page, where a subscription can be '
      + 'cancelled. A redirect to somebody else’s interface.',
  },
  {
    route: 'POST /api/v1/billing/create-portal',
    reason:
      'The same flow under an older name, kept for compatibility. Excluded for the same '
      + 'reason as the name that replaced it.',
  },

  /* --- the Confluence integration ---------------------------------------- */
  {
    route: 'POST /api/v1/integrations/confluence/callback',
    reason:
      'The return leg of a browser sign-in with Atlassian. It cannot be driven from outside a '
      + 'browser, and it carries a one-time code that has already been spent by the time '
      + 'anything else could see it.',
    notInGroupIndex: true,
  },
  {
    route: 'DELETE /api/v1/integrations/confluence',
    reason:
      'Disconnects Confluence, which deletes the mirrored pages. The owner has ruled that '
      + 'CharityPilot must never delete from Confluence, and this route is never to be offered '
      + 'here regardless of session level.',
    notInGroupIndex: true,
  },
  {
    route: 'PUT /api/v1/integrations/confluence/publish-space',
    reason:
      'Chooses which Confluence space the charity’s documents are mirrored into. A setting '
      + 'made once, while looking at a list of spaces the connector does not show.',
    notInGroupIndex: true,
  },

  /* --- operational recovery ---------------------------------------------- */
  {
    route: 'POST /api/v1/documents/storage-deletions/:id/requeue',
    reason:
      'Retries a failed erasure from the dead-letter queue. It is deliberately behind a typed '
      + 'confirmation, because requeuing the wrong row deletes the wrong file.',
  },

  /* --- the browser sign-in realm ------------------------------------------ */
  //
  // The connector has its own sign-in routes and uses those. Every route here
  // either establishes a browser session, or sets a password, or is a step in a
  // sign-up flow that only makes sense in a browser. None of them is something
  // an already signed-in connector has any business calling.
  {
    route: 'POST /api/v1/auth/register',
    reason:
      'Creates an account and a charity. A connector signs in as somebody who already has '
      + 'one; it has no standing to create another.',
  },
  {
    route: 'POST /api/v1/auth/login',
    reason:
      'Establishes a BROWSER session and sets cookies. The connector signs in through its '
      + 'own route instead, which returns tokens in the body and sets no cookie.',
  },
  {
    route: 'POST /api/v1/auth/refresh',
    reason:
      'Rotates a browser session. A connector token is refused here deliberately, so that a '
      + 'credential lifted from one channel is useless in the other.',
  },
  {
    route: 'POST /api/v1/auth/logout',
    reason:
      'Ends a browser session. The connector ends its own through its own route, which is '
      + 'what disconnect does.',
  },
  {
    route: 'POST /api/v1/auth/approvals/:id/grant',
    reason:
      'Grants a pending approval after checking a password, for the person using the web '
      + 'application because they have no terminal to type at. The entire value of '
      + 'per-action approval is that the agent which asked for the action cannot also grant '
      + 'it, so this must never be reachable as a tool — exactly as the connector realm’s '
      + 'own approve route must not be.',
  },
  {
    route: 'POST /api/v1/auth/forgot-password',
    reason:
      'Starts a password reset by email. Nothing in a password-recovery flow should be '
      + 'reachable by something already holding the credential it would reset.',
  },
  {
    route: 'POST /api/v1/auth/reset-password',
    reason: 'Sets a new password from a one-time link. See the route that starts that flow.',
  },
  {
    route: 'POST /api/v1/auth/verify-email',
    reason:
      'Confirms an email address from a one-time link, as part of signing up. It has no '
      + 'meaning for an account that is already signed in.',
  },
  {
    route: 'POST /api/v1/auth/resend-verification',
    reason: 'Sends that confirmation link again, with the same reasoning.',
  },

  /* --- the connector's own sign-in ---------------------------------------- */
  //
  // These are how the connector authenticates and how a person approves an
  // action. They are driven by the command-line commands, never by a tool: a
  // tool that could sign in or approve would defeat the point of both.
  {
    route: 'POST /api/v1/auth/connector/login',
    reason:
      'How the connector signs in, driven by the connect command. A tool for it would mean '
      + 'an agent could sign in as somebody, which is exactly what the password prompt exists '
      + 'to prevent.',
    notInGroupIndex: true,
  },
  {
    route: 'POST /api/v1/auth/connector/refresh',
    reason:
      'Session rotation, handled inside the connector on every call. Exposing it as a tool '
      + 'would let an agent spend the refresh token deliberately.',
    notInGroupIndex: true,
  },
  {
    route: 'POST /api/v1/auth/connector/logout',
    reason: 'How disconnect revokes the session. A tool would let an agent sign the person out.',
    notInGroupIndex: true,
  },
  {
    route: 'POST /api/v1/auth/connector/approve',
    reason:
      'Grants an approval after checking a password typed at a terminal. The entire value of '
      + 'per-action approval is that the agent which asked for the action cannot also grant '
      + 'it, so this must never be reachable as a tool.',
    notInGroupIndex: true,
  },

  /* --- routes that duplicate one already offered --------------------------- */
  {
    route: 'POST /api/v1/documents/:id/link-standard',
    reason:
      'An older spelling of the route the web application uses, kept for compatibility. The '
      + 'connector offers the current one, and offering both would be two names for one action.',
  },
  {
    route: 'DELETE /api/v1/documents/:id/unlink-standard',
    reason:
      'An older spelling of the unlink route, kept for compatibility. The connector offers '
      + 'the current one, which names the standard being unlinked.',
  },
];
